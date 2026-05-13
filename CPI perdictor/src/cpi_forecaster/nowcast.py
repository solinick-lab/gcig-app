"""CPI nowcaster — predicts the CURRENT month's CPI before BLS releases it.

Standard forecasters predict month T given monthly data through T-1.
The nowcaster ALSO uses partial-month daily data through "today" (the
20th, the 25th, whatever day it actually is). By the 20th of a month,
you've seen most of the daily price movement that drives current-month
CPI — ignoring it means leaving 2/3 of the available signal on the table.

Architecture:
  - Pulls the daily panel via gcig-api
  - Pulls the monthly panel as well (for last-released CPI + monthly
    macro features)
  - Builds aligned (X, y) where:
        X[t] = monthly features through month t-1
             + within-month features as of "day 20 of month t"
        y[t] = actual MoM log-% of CPI[t]
  - Trains Ridge + GradientBoostingRegressor (quantile median); ensembles
  - At inference: today's as-of date, predicts current month's MoM

Backtest: walk forward N months. At each cut t_cut, simulate "as of day
20 of month t_cut" using only data available by that date. Predict CPI[t_cut].
Compare to actual CPI[t_cut] when published.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast_features import build_daily_frame, features_at


# How far into the month do we simulate the nowcast at training time.
# Day 20 is a sensible default — most of the daily action has happened
# but BLS hasn't released yet (release is around day 10-13 of NEXT month).
DEFAULT_AS_OF_DAY = 20


@dataclass
class NowcastResult:
    as_of: pd.Timestamp
    target_month: str          # "YYYY-MM"
    pred_mom: float            # predicted MoM log-%
    pred_yoy: float            # predicted YoY %
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int         # how many days of partial-month signal we used


def _as_of_for_month(month_start: pd.Timestamp, day: int) -> pd.Timestamp:
    """Return min(month_start + day - 1, last day of that month)."""
    next_month = month_start + pd.offsets.MonthBegin(1)
    candidate = month_start + pd.Timedelta(days=day - 1)
    last = next_month - pd.Timedelta(days=1)
    return min(candidate, last)


def _build_supervised(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Build (X, y) for the nowcaster.

    For each historical month T where:
      - we have CPI[T] (ground truth)
      - we have CPI[T-1] (lag for monthly features)
      - we have daily data through day `as_of_day` of T
    construct one row:
      X = monthly lag features (CPI MoM lag 1, oil monthly avg lag 1, etc.)
        + within-month features as of (T_start + as_of_day - 1)
      y = CPI MoM log-% at T
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    # Skip the first months with no lag data.
    eligible_months = y_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        # Month start for this month_end (it's already month-end).
        m_start = month_end - pd.offsets.MonthEnd(0) + pd.offsets.MonthBegin(-1)
        # Wait — month_end is already at month-end, so prior MonthBegin gives month start.
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)

        # Skip if as_of is in the future (we have y_mom but not daily yet).
        # Skip if daily data doesn't reach as_of for ANY series.
        # (We allow individual NaN features — they get imputed at fit time.)
        feats = features_at(daily_frame, as_of)
        # Add lag features from monthly panel.
        feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])  # T-1
        feats["cpi_mom_lag2"] = float(y_mom.loc[:month_end].iloc[-3]) if len(y_mom.loc[:month_end]) >= 3 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (cpi.loc[:month_end].iloc[-2] / cpi.loc[:month_end].iloc[-14] - 1.0) * 100.0
        ) if len(cpi.loc[:month_end]) >= 14 else np.nan
        # Calendar
        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    # Drop columns that are entirely NaN (e.g., a series not in panel at all).
    df = df.dropna(axis=1, how="all")
    # Median-impute remaining NaN — Ridge can't handle NaN.
    df = df.fillna(df.median(numeric_only=True))
    return df, y


@dataclass
class NowcastModel:
    scaler: StandardScaler
    ridge: RidgeCV
    gbr: GradientBoostingRegressor
    feature_cols: list[str]
    resid_std: float
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Predict (mean, lo80, hi80) for one as-of feature vector."""
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        x_s = self.scaler.transform(x_aligned)
        ridge_pred = float(self.ridge.predict(x_s)[0])
        gbr_pred = float(self.gbr.predict(x_aligned)[0])
        mean = (ridge_pred + gbr_pred) / 2.0
        z = 1.2816  # 80%
        return mean, mean - z * self.resid_std, mean + z * self.resid_std


def fit_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> NowcastModel:
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    scaler = StandardScaler().fit(X.values)
    Xs = scaler.transform(X.values)
    ridge = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Xs, y.values)
    gbr = GradientBoostingRegressor(
        loss="quantile", alpha=0.5, n_estimators=300,
        max_depth=3, learning_rate=0.05, random_state=42,
    ).fit(X.values, y.values)
    # Residuals from a 50/50 blend of in-sample preds.
    blend = (ridge.predict(Xs) + gbr.predict(X.values)) / 2.0
    resid = y.values - blend
    resid_std = float(np.std(resid))
    return NowcastModel(
        scaler=scaler, ridge=ridge, gbr=gbr,
        feature_cols=cols, resid_std=resid_std, as_of_day=as_of_day,
    )


def run_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    """Top-level: fetch panels, train, produce a current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    # Inference: today's as-of date, target = current month
    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]  # the last month we actually have CPI for
    # Target month is the month AFTER the last released — that's what we nowcast.
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    # Build features as of today (or last day of target month, whichever is earlier).
    as_of = min(today, target_month_end)
    # If today is before the target month started, nothing to nowcast — fall back to as_of_day of target month start
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    pred_mom, lo, hi = model.predict_one(pd.Series(feats))

    # MoM → YoY: predicted CPI level = last_cpi * exp(pred_mom/100).
    # YoY denominator = CPI 12 months before target_month.
    last_cpi = float(cpi.iloc[-1])
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    pred_yoy = (predicted_cpi / denom - 1.0) * 100.0

    # YoY interval: chain lo/hi MoMs through the same conversion.
    pred_cpi_lo = last_cpi * float(np.exp(lo / 100.0))
    pred_cpi_hi = last_cpi * float(np.exp(hi / 100.0))
    lo80_yoy = (pred_cpi_lo / denom - 1.0) * 100.0
    hi80_yoy = (pred_cpi_hi / denom - 1.0) * 100.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the nowcaster: at each historical cut t,
    train on data up to t-1, predict t. Return RMSE/MAE/hit-rate."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        target_month_end = y_mom.index[ci]
        # Train on data BEFORE target_month_end.
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue
        # For training: use full daily history but restrict month-end-targets via _build_supervised.
        try:
            model = fit_nowcast_model(train_panel, daily_frame, as_of_day=as_of_day)
        except Exception:
            continue
        # Build the inference feature row for this cut, simulating as-of day `as_of_day` of target month.
        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = features_at(daily_frame, as_of)
        # Lag features from train_panel.
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            continue
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

        pred_mom, _, _ = model.predict_one(pd.Series(feats))
        actual_mom = float(y_mom.iloc[ci])

        # YoY conversion
        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        pred_cpi = last_cpi_train * float(np.exp(pred_mom / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (pred_cpi / denom - 1.0) * 100.0
        actual_cpi = float(cpi.loc[target_month_end])
        actual_yoy = (actual_cpi / denom - 1.0) * 100.0

        preds_mom.append(pred_mom)
        actuals_mom.append(actual_mom)
        preds_yoy.append(pred_yoy)
        actuals_yoy.append(actual_yoy)
        rows.append({
            "target_month": target_month_end.strftime("%Y-%m"),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "pred_mom": round(pred_mom, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(pred_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(pred_yoy - actual_yoy, 3),
        })

    if not preds_mom:
        return {"error": "no successful cuts"}

    pm = np.array(preds_mom); am = np.array(actuals_mom)
    py = np.array(preds_yoy); ay = np.array(actuals_yoy)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_mom),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }
