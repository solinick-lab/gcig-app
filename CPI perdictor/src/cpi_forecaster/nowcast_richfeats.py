"""Rich within-month feature CPI nowcaster (Agent KKK).

Same interface as `nowcast.backtest_nowcast` / `nowcast.run_nowcast`, but
with a much richer within-month feature set:

  - Multiple time-window momentum: 3, 7, 14, 21 day windows.
  - Volatility within MTD: std of daily returns over month-to-date.
  - Acceleration: (last-7-day pct change) - (prior-7-day pct change).
  - Cross-asset interactions: oil*USD, oil*HY-spread, breakeven curve slope.
  - Day-of-month spike detector: is recent move outsized vs MTD baseline?
  - Weekend/weekday counts in MTD.

The model is Ridge + GradientBoostingRegressor (quantile median) blended
50/50, identical chain to the baseline (MoM log-% -> YoY).

Constraints respected:
  - DO NOT modify any other file.
  - Use only existing dependencies (numpy, pandas, scikit-learn).
  - Wrapped in try/except where appropriate.
  - Per-cut runtime kept low (small grid of features, modest GBR size).
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
from .nowcast_features import build_daily_frame


DEFAULT_AS_OF_DAY = 20


# Series IDs we care about (mirror nowcast_features._DAILY_IDS / _WEEKLY_IDS,
# kept local to avoid touching the other module).
_DAILY_IDS = (
    "DCOILWTICO",
    "DCOILBRENTEU",
    "DTWEXBGS",
    "DGS10",
    "DGS2",
    "T10Y2Y",
    "T10Y3M",
    "T5YIE",
    "T10YIE",
    "T5YIFR",
    "BAMLH0A0HYM2",
)

_WEEKLY_IDS = (
    "GASREGW",
    "GASDESW",
    "ICSA",
)


@dataclass
class RichNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _month_start(ts: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(year=ts.year, month=ts.month, day=1)


def _as_of_for_month(month_start: pd.Timestamp, day: int) -> pd.Timestamp:
    next_month = month_start + pd.offsets.MonthBegin(1)
    candidate = month_start + pd.Timedelta(days=day - 1)
    last = next_month - pd.Timedelta(days=1)
    return min(candidate, last)


def _window_mean(s: pd.Series, end: pd.Timestamp, n: int) -> float:
    """Mean of `s` over the n calendar days ending at `end`."""
    start = end - pd.Timedelta(days=n)
    w = s.loc[(s.index > start) & (s.index <= end)]
    if len(w) == 0:
        return np.nan
    return float(w.mean())


def _window_pct_change(s: pd.Series, end: pd.Timestamp, n: int) -> float:
    """Percent change between [end-2n, end-n] and (end-n, end] windows."""
    recent = _window_mean(s, end, n)
    mid = end - pd.Timedelta(days=n)
    prior = _window_mean(s, mid, n)
    if not np.isfinite(recent) or not np.isfinite(prior) or prior == 0:
        return np.nan
    return (recent / prior - 1.0) * 100.0


def _mtd_window(s: pd.Series, as_of: pd.Timestamp) -> pd.Series:
    start = _month_start(as_of)
    return s.loc[(s.index >= start) & (s.index <= as_of)]


def _prior_month_window(s: pd.Series, as_of: pd.Timestamp) -> pd.Series:
    this_start = _month_start(as_of)
    prior_end = this_start - pd.Timedelta(days=1)
    prior_start = _month_start(prior_end)
    return s.loc[(s.index >= prior_start) & (s.index <= prior_end)]


def _safe(x: float) -> float:
    """Coerce to float, leaving NaN as NaN (no inf)."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return np.nan
    if not np.isfinite(v):
        return np.nan
    return v


def _daily_returns(s: pd.Series) -> pd.Series:
    """Log-pct daily returns for series s (values strictly positive expected)."""
    if len(s) < 2:
        return pd.Series([], dtype=float)
    arr = s.values.astype(float)
    # Avoid div-by-zero / non-positive
    safe_prev = np.where(arr[:-1] != 0, arr[:-1], np.nan)
    rets = (arr[1:] / safe_prev - 1.0) * 100.0
    return pd.Series(rets, index=s.index[1:])


# ---------------------------------------------------------------------------
# Rich feature builder
# ---------------------------------------------------------------------------


def rich_features_at(
    daily_frame: dict[str, pd.Series],
    as_of: pd.Timestamp,
) -> dict[str, float]:
    """Compute the rich within-month feature dict for one as-of date.

    Per daily series:
      - mom3 / mom7 / mom14 / mom21    (window pct changes)
      - vol_mtd                        (std of daily returns MTD)
      - accel_7v7                      (last-7d pct change minus prior-7d)
      - mtd_pct                        (MTD avg vs prior-month avg)
      - mtd_n / completeness           (sample completeness)
      - spike                          (latest 3d move vs MTD std baseline)
    Cross-asset:
      - oil_usd_mom7                   (oil last-7d pct * USD last-7d pct)
      - oil_hy_mom7                    (oil last-7d pct * HY-spread last-7d pct)
      - breakeven_slope                (T10YIE - T5YIE) latest
    Calendar:
      - mtd_weekday_count, mtd_weekend_count
    Weekly series:
      - latest, 4wk_pct
    """
    feats: dict[str, float] = {}

    # ---- Per daily series rich features ----
    for sid, s in daily_frame.items():
        if sid not in _DAILY_IDS or s is None or len(s) == 0:
            continue
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            continue

        # Multi-window momentum
        for n in (3, 7, 14, 21):
            feats[f"{sid}_mom{n}"] = _safe(_window_pct_change(s_until, as_of, n))

        # MTD avg vs prior-month avg
        mtd = _mtd_window(s_until, as_of)
        prior = _prior_month_window(s_until, as_of)
        mtd_n = int(len(mtd))
        feats[f"{sid}_mtd_n"] = float(mtd_n)
        feats[f"{sid}_completeness"] = min(mtd_n, 31) / 31.0
        if len(prior) > 0 and len(mtd) > 0:
            p_avg = float(prior.mean())
            m_avg = float(mtd.mean())
            if np.isfinite(p_avg) and p_avg != 0 and np.isfinite(m_avg):
                feats[f"{sid}_mtd_pct"] = (m_avg / p_avg - 1.0) * 100.0
            else:
                feats[f"{sid}_mtd_pct"] = np.nan
        else:
            feats[f"{sid}_mtd_pct"] = np.nan

        # Volatility within MTD (std of daily returns)
        if len(mtd) >= 3:
            rets = _daily_returns(mtd)
            feats[f"{sid}_vol_mtd"] = _safe(rets.std()) if len(rets) > 1 else np.nan
        else:
            feats[f"{sid}_vol_mtd"] = np.nan

        # Acceleration: last-7d pct change minus prior-7d pct change.
        # We compare two independent 7-day windows: (as_of - 7, as_of] and
        # (as_of - 14, as_of - 7].
        last7 = _window_mean(s_until, as_of, 7)
        prior7 = _window_mean(s_until, as_of - pd.Timedelta(days=7), 7)
        prior14 = _window_mean(s_until, as_of - pd.Timedelta(days=14), 7)
        if (
            np.isfinite(last7) and np.isfinite(prior7) and np.isfinite(prior14)
            and prior7 != 0 and prior14 != 0
        ):
            r1 = (last7 / prior7 - 1.0) * 100.0
            r0 = (prior7 / prior14 - 1.0) * 100.0
            feats[f"{sid}_accel_7v7"] = r1 - r0
        else:
            feats[f"{sid}_accel_7v7"] = np.nan

        # Day-of-month spike detector: how big is the latest 3-day move
        # relative to MTD daily-return std (z-score-ish)?
        if len(mtd) >= 5:
            rets = _daily_returns(mtd)
            if len(rets) >= 3:
                recent3_mean = float(rets.iloc[-3:].mean())
                std = float(rets.std()) if len(rets) > 1 else np.nan
                if np.isfinite(std) and std > 0:
                    feats[f"{sid}_spike"] = recent3_mean / std
                else:
                    feats[f"{sid}_spike"] = np.nan
            else:
                feats[f"{sid}_spike"] = np.nan
        else:
            feats[f"{sid}_spike"] = np.nan

    # ---- Cross-asset interactions ----
    def _last7(sid: str) -> float:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            return np.nan
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            return np.nan
        return _safe(_window_pct_change(s_until, as_of, 7))

    oil = _last7("DCOILWTICO")
    usd = _last7("DTWEXBGS")
    hy = _last7("BAMLH0A0HYM2")
    if np.isfinite(oil) and np.isfinite(usd):
        feats["x_oil_usd_mom7"] = oil * usd
    else:
        feats["x_oil_usd_mom7"] = np.nan
    if np.isfinite(oil) and np.isfinite(hy):
        feats["x_oil_hy_mom7"] = oil * hy
    else:
        feats["x_oil_hy_mom7"] = np.nan

    # Breakeven curve slope: T10YIE - T5YIE at the latest point as of as_of
    def _latest_value(sid: str) -> float:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            return np.nan
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            return np.nan
        return _safe(s_until.iloc[-1])

    t10ie = _latest_value("T10YIE")
    t5ie = _latest_value("T5YIE")
    if np.isfinite(t10ie) and np.isfinite(t5ie):
        feats["x_breakeven_slope"] = t10ie - t5ie
    else:
        feats["x_breakeven_slope"] = np.nan

    # ---- Calendar: weekend/weekday counts in MTD (uses any available daily
    # series' index density isn't ideal — instead just count calendar days). ----
    start = _month_start(as_of)
    days = pd.date_range(start=start, end=as_of, freq="D")
    weekend_count = int(sum(d.weekday() >= 5 for d in days))
    weekday_count = int(len(days) - weekend_count)
    feats["mtd_weekday_count"] = float(weekday_count)
    feats["mtd_weekend_count"] = float(weekend_count)

    # ---- Weekly series ----
    for sid, s in daily_frame.items():
        if sid not in _WEEKLY_IDS or s is None or len(s) == 0:
            continue
        recent = s.loc[s.index <= as_of]
        if len(recent) == 0:
            feats[f"{sid}_latest"] = np.nan
            feats[f"{sid}_4wk_pct"] = np.nan
            continue
        feats[f"{sid}_latest"] = _safe(recent.iloc[-1])
        last4 = recent.iloc[-4:]
        prior4 = recent.iloc[-8:-4] if len(recent) >= 8 else None
        if prior4 is not None and len(prior4) > 0:
            r = float(last4.mean())
            p = float(prior4.mean())
            feats[f"{sid}_4wk_pct"] = ((r / p - 1.0) * 100.0) if p != 0 else np.nan
        else:
            feats[f"{sid}_4wk_pct"] = np.nan

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset / model
# ---------------------------------------------------------------------------


def _build_supervised_rich(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    eligible_months = y_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)

        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        try:
            feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
        try:
            feats["cpi_mom_lag2"] = (
                float(y_mom.loc[:month_end].iloc[-3])
                if len(y_mom.loc[:month_end]) >= 3 else np.nan
            )
        except Exception:
            feats["cpi_mom_lag2"] = np.nan
        try:
            cpi_until = cpi.loc[:month_end]
            if len(cpi_until) >= 14:
                feats["cpi_yoy_lag1"] = float(
                    (cpi_until.iloc[-2] / cpi_until.iloc[-14] - 1.0) * 100.0
                )
            else:
                feats["cpi_yoy_lag1"] = np.nan
        except Exception:
            feats["cpi_yoy_lag1"] = np.nan

        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    # Any column whose median was also NaN (entirely empty after first dropna
    # might re-introduce it via reindex) — final fillna(0).
    df = df.fillna(0.0)
    return df, y


@dataclass
class RichNowcastModel:
    scaler: StandardScaler
    ridge: RidgeCV
    gbr: GradientBoostingRegressor
    feature_cols: list[str]
    resid_std: float
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        x_s = self.scaler.transform(x_aligned)
        ridge_pred = float(self.ridge.predict(x_s)[0])
        gbr_pred = float(self.gbr.predict(x_aligned)[0])
        mean = (ridge_pred + gbr_pred) / 2.0
        z = 1.2816  # 80%
        return mean, mean - z * self.resid_std, mean + z * self.resid_std


def fit_rich_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> RichNowcastModel:
    X, y = _build_supervised_rich(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    scaler = StandardScaler().fit(X.values)
    Xs = scaler.transform(X.values)
    ridge = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Xs, y.values)
    gbr = GradientBoostingRegressor(
        loss="quantile", alpha=0.5, n_estimators=300,
        max_depth=3, learning_rate=0.05, random_state=42,
    ).fit(X.values, y.values)
    blend = (ridge.predict(Xs) + gbr.predict(X.values)) / 2.0
    resid = y.values - blend
    resid_std = float(np.std(resid))
    return RichNowcastModel(
        scaler=scaler, ridge=ridge, gbr=gbr,
        feature_cols=cols, resid_std=resid_std, as_of_day=as_of_day,
    )


# ---------------------------------------------------------------------------
# Public entry points (same signatures/return shapes as nowcast.* )
# ---------------------------------------------------------------------------


def run_rich_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> RichNowcastResult:
    """Top-level: fetch panels, train rich-feature model, current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_rich_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    pred_mom, lo, hi = model.predict_one(pd.Series(feats))

    last_cpi = float(cpi.iloc[-1])
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    pred_yoy = (predicted_cpi / denom - 1.0) * 100.0

    pred_cpi_lo = last_cpi * float(np.exp(lo / 100.0))
    pred_cpi_hi = last_cpi * float(np.exp(hi / 100.0))
    lo80_yoy = (pred_cpi_lo / denom - 1.0) * 100.0
    hi80_yoy = (pred_cpi_hi / denom - 1.0) * 100.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return RichNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_rich_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest mirroring `nowcast.backtest_nowcast`."""
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
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue
        try:
            model = fit_rich_nowcast_model(train_panel, daily_frame, as_of_day=as_of_day)
        except Exception:
            continue

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

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

        try:
            pred_mom, _, _ = model.predict_one(pd.Series(feats))
        except Exception:
            continue
        actual_mom = float(y_mom.iloc[ci])

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
