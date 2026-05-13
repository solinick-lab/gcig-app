"""Smoothed quantile nowcaster — average of q=0.4, 0.5, 0.6 GBR predictions.

Yellen 1.1 uses the q=0.5 quantile alone as its point forecast. Pinball loss
at any single alpha is a noisy estimator of the conditional median: small
training-set perturbations swing the fitted regressor, and the median of the
GBR's leaf distribution is itself a step function of the data. A simple way
to dampen that idiosyncrasy without leaving the quantile-loss family is to
average the predictions of three quantile fits sitting just around the
center: q=0.4, q=0.5, and q=0.6.

Why this should beat q=0.5 alone:
  - Pinball loss at q is asymmetric. The triple {0.4, 0.5, 0.6} averages
    out the asymmetry tails and approximates a tightly-trimmed conditional
    mean while still being robust to heavy tails (unlike OLS).
  - Each separate fit sees a slightly different gradient signal — averaging
    three fits is itself a mild ensemble that reduces fitting variance,
    much like bagging but free of the random-subsample noise.
  - The three quantiles are NEAR each other, so we are NOT inflating
    interval bands here: the average is a POINT estimator only. Bands
    still come from the q=0.1 / q=0.9 endpoints of the underlying clev
    feature stack, fitted alongside.

Architecture: reuses Yellen 1.1's feature set verbatim
(`nowcast_clev._build_supervised_clev` + `_clev_features_for_month`), so
the only change vs. clev_nowcast is the head model: instead of taking the
median of (q=0.1, q=0.5, q=0.9), we additionally fit q=0.4 and q=0.6 and
return the average of (q=0.4, q=0.5, q=0.6) as the point forecast. The
existing q=0.1 and q=0.9 fits provide the 80% bands.

Public API:
  backtest_smoothq_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_smoothq_nowcast(as_of_day=20) -> SmoothQNowcastResult

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5]. The shape
of the returned dict mirrors the rest of the nowcast family.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import (
    _build_supervised_clev,
    _clev_features_for_month,
    _mom_to_yoy,
    _safe_get_clev,
    _MOM_HI_CLIP,
    _MOM_LO_CLIP,
    _RESID_FLOOR,
)
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

# Center quantiles whose predictions we will AVERAGE for the point forecast.
_SMOOTH_QUANTILES = (0.4, 0.5, 0.6)
# Outer quantiles for the 80% interval (kept for parity with the rest of
# the clev family).
_BAND_QUANTILES = (0.1, 0.9)
_ALL_QUANTILES = tuple(sorted(set(_SMOOTH_QUANTILES) | set(_BAND_QUANTILES)))

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class SmoothQNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_smooth_quantile_models(
    X: pd.DataFrame, y: pd.Series,
) -> dict[float, GradientBoostingRegressor]:
    """Fit GBR-quantile at each q in _ALL_QUANTILES = {0.1, 0.4, 0.5, 0.6, 0.9}.

    The {0.4, 0.5, 0.6} trio drives the smoothed point forecast; {0.1, 0.9}
    drive the 80% interval. All are independent fits; quantile crossing is
    handled at predict time by sorting (band only).
    """
    Xv = X.values
    yv = y.values
    models: dict[float, GradientBoostingRegressor] = {}
    for q in _ALL_QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
    return models


def _predict_smoothed(
    models: dict[float, GradientBoostingRegressor],
    x_inf: pd.Series,
    cols: list[str],
) -> tuple[float, float, float]:
    """Return (smoothed_pred_mom, lo10, hi90) for one feature row.

    smoothed_pred_mom = mean of model predictions at q in {0.4, 0.5, 0.6}.
    The interval endpoints come from q=0.1 and q=0.9. We sort the triple
    {lo, smoothed_pred, hi} so the bands cannot crash through the point
    forecast in case of mild quantile crossing.
    """
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    center_preds = [float(models[q].predict(aligned)[0]) for q in _SMOOTH_QUANTILES]
    smoothed = float(np.mean(center_preds))
    lo = float(models[_BAND_QUANTILES[0]].predict(aligned)[0])
    hi = float(models[_BAND_QUANTILES[1]].predict(aligned)[0])
    triple = sorted([lo, smoothed, hi])
    return triple[1], triple[0], triple[2]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_smoothq_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the smoothed-quantile nowcaster on Yellen 1.1's
    feature set.

    For each cut t in the trailing window:
      - build the same supervised matrix as clev_nowcast
      - fit five quantile GBRs at q={0.1, 0.4, 0.5, 0.6, 0.9}
      - average the {0.4, 0.5, 0.6} predictions as the smoothed MoM forecast
      - clip MoM to [-1.5, 2.5], chain to YoY against published CPI

    Single-cut failures (insufficient history, fit error, etc.) are skipped
    via try/except so one bad month doesn't sink the window. Return shape
    matches `backtest_clev_nowcast` exactly.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_smooth_quantile_models(X, y)
            cols = list(X.columns)

            # Inference features — same recipe as nowcast_clev.
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = (
                float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            )
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            mid, _lo, _hi = _predict_smoothed(models, x_inf, cols)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
            })
        except Exception:
            # One bad cut shouldn't kill the whole walk-forward.
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
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_smoothq_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SmoothQNowcastResult:
    """Live nowcast: smoothed-q point forecast on Yellen 1.1's feature set."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_smooth_quantile_models(X, y)
    cols = list(X.columns)

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
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
    mid, lo, hi = _predict_smoothed(models, x_inf, cols)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return SmoothQNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
