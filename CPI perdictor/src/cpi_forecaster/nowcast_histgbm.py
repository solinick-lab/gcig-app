"""HistGradientBoosting CPI nowcaster.

The pure-quantile nowcaster (`nowcast_quantile.py`) replaced the Ridge+GBR
ensemble with three independently-fit `GradientBoostingRegressor`s using
pinball loss at q={0.1, 0.5, 0.9}. That works, but vanilla
`GradientBoostingRegressor` is the slow, sample-by-sample sklearn impl —
it scales poorly and tends to overfit on the small monthly panel.

This module swaps the underlying tree learner for
`HistGradientBoostingRegressor`, sklearn's histogram-binning GBT
(LightGBM-equivalent). Two practical wins:

  1) Histogram binning over feature values is dramatically faster and
     produces smoother decision boundaries on tabular data — usually
     wins on this size of panel.
  2) Native `loss='quantile'` with a `quantile=` parameter and built-in
     early-stopping makes it a near-drop-in for the GBR triple, while
     guarding against overfit on fewer than ~200 training rows.

Architecture is unchanged: same supervised-feature builder
(`_build_supervised`), same lag conventions, same MoM->YoY chain,
same monotonic sort to handle quantile crossing, same MoM clip and
YoY half-width floor. Only the head model changes.

Each historical cut is wrapped in try/except — one bad fit doesn't
kill the 24-month walk-forward backtest. If the entire fit pipeline
explodes at inference time, `run_histgbm_nowcast` falls back to the
quantile baseline so the production endpoint never returns a hard error.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval to avoid collapse

# HistGBM-specific hyperparameters. max_iter=400 mirrors the GBR
# n_estimators=400 from the quantile baseline; max_depth=4 gives the
# histogram learner one extra level since binning is more
# regularizing than greedy split-finding. Early stopping leaves the
# library to pick the actual best iter count on a held-out validation.
_HGBR_PARAMS = dict(
    max_iter=400,
    max_depth=4,
    learning_rate=0.05,
    random_state=42,
    early_stopping=True,
)


@dataclass
class HistGBMNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class HistGBMNowcastModel:
    models: dict[float, HistGradientBoostingRegressor]
    feature_cols: list[str]
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (pred_mom_median, lo10, hi90) for one feature row.

        Sorts the triple to enforce monotonicity in case of quantile
        crossing. The middle of the sorted triple is the point forecast.
        """
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        # preds = [q0.1, q0.5, q0.9] in order
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


def fit_histgbm_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> HistGBMNowcastModel:
    """Fit three quantile-loss HistGradientBoostingRegressors on the supervised (X, y) panel."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    models: dict[float, HistGradientBoostingRegressor] = {}
    for q in _QUANTILES:
        hgbr = HistGradientBoostingRegressor(
            loss="quantile", quantile=q, **_HGBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = hgbr

    return HistGBMNowcastModel(
        models=models,
        feature_cols=cols,
        as_of_day=as_of_day,
    )


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Feature row for the cut, simulating as-of `as_of_day` of target month."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Convert predicted MoM log-% to YoY % using the same chain logic
    the baseline uses: predicted_cpi = last_cpi * exp(mom/100), divide
    by CPI from 12 months before target_month."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


def run_histgbm_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> HistGBMNowcastResult:
    """Pull live panels, fit HistGBM model, produce a current-month forecast.

    Wrapped in try/except: if anything in the fit/predict pipeline
    raises, fall back to the pure-quantile baseline so the production
    endpoint never returns a hard error.
    """
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    try:
        model = fit_histgbm_nowcast_model(panel, daily_frame, as_of_day=as_of_day)
    except Exception:
        # Fallback: defer to the quantile baseline.
        from .nowcast_quantile import run_quantile_nowcast
        q = run_quantile_nowcast(as_of_day=as_of_day)
        return HistGBMNowcastResult(
            as_of=q.as_of,
            target_month=q.target_month,
            pred_mom=q.pred_mom,
            pred_yoy=q.pred_yoy,
            lo80_yoy=q.lo80_yoy,
            hi80_yoy=q.hi80_yoy,
            days_observed=q.days_observed,
        )

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    try:
        pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    except Exception:
        from .nowcast_quantile import run_quantile_nowcast
        q = run_quantile_nowcast(as_of_day=as_of_day)
        return HistGBMNowcastResult(
            as_of=q.as_of,
            target_month=q.target_month,
            pred_mom=q.pred_mom,
            pred_yoy=q.pred_yoy,
            lo80_yoy=q.lo80_yoy,
            hi80_yoy=q.hi80_yoy,
            days_observed=q.days_observed,
        )

    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

    # Floor the half-widths so a tight quantile fit doesn't collapse the band.
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return HistGBMNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_histgbm_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the HistGBM nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train three quantile HistGBMs on data strictly BEFORE t
      - predict t's MoM at q={0.1, 0.5, 0.9}, sort, take median
      - clip to [-1.5, 2.5], chain to YoY against the actual published
        CPI from 12 months prior

    A single failed cut (insufficient history, fit failure, etc.) is
    skipped via try/except — it shouldn't poison the rest of the window.

    Return shape mirrors `nowcast.backtest_nowcast` exactly.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []
    last_as_of: pd.Timestamp | None = None

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            model = fit_histgbm_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day,
            )
            last_as_of = as_of

            pred_mom, _, _ = model.predict_one(pd.Series(feats))
            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(pred_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
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
        except Exception:
            # One bad cut shouldn't tank the whole backtest.
            continue

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
