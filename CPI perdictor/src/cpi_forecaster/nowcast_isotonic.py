"""Isotonic (non-parametric monotone) calibration on top of clev_calibrated.

Hypothesis: clev_calibrated removes systematic LINEAR bias via Ridge, but
the residual bias structure may itself be non-linear and monotone in the
base prediction (e.g. the model may overshoot proportionally MORE for
large positive predictions than for moderate ones — a curvature that a
linear correction cannot capture). A monotone isotonic regression on the
in-sample (pred, actual) pairs gives a flexible, non-parametric correction
that preserves the rank-ordering of predictions while bending the
mapping wherever the data demands.

Approach:
  1. For each backtest cut, run the base clev_nowcast pipeline on the
     training window. Collect (pred_in_sample, actual) pairs from the
     median quantile model evaluated on the training rows.
  2. Fit `sklearn.isotonic.IsotonicRegression(out_of_bounds="clip")` on
     those pairs. The fitted function f: R -> R is piecewise-constant
     and monotone non-decreasing (so f(pred) preserves the model's
     direction-of-effect ordering).
  3. Apply f to the live base prediction. The 80% bands are shifted by
     the same scalar correction, f(mid_base) - mid_base, preserving
     quantile widths (calibration removes bias, not spread).
  4. Fall back to base prediction when too few calibration rows.

Public API:
  backtest_isotonic_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_isotonic_nowcast(as_of_day=20) -> IsotonicNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5]. Different
from linear calibration: isotonic is non-parametric and can fit any
monotone function shape, not just an affine line.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _fit_quantile_models,
    _predict_triple,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_MIN_ISO_ROWS = 18           # need a decent (pred, actual) history
_ISO_CLIP_DELTA = 0.30       # cap how much isotonic can shift base pred (MoM)


@dataclass
class IsotonicNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    iso_shift_mom: float       # f(base) - base, before clipping
    n_iso_rows: int


# ---------------------------------------------------------------------------
# Isotonic calibrator
# ---------------------------------------------------------------------------


def _build_iso_pairs(
    X: pd.DataFrame,
    y: pd.Series,
    models: dict,
) -> tuple[np.ndarray, np.ndarray]:
    """Collect in-sample (pred, actual) pairs from the median quantile model.

    Same source of pairs as the linear calibrator, but here we keep
    just the (pred, actual) tuple — isotonic is univariate.
    """
    if len(X) == 0:
        return np.zeros((0,)), np.zeros((0,))
    try:
        median_model = models[0.5]
        preds = median_model.predict(X.values)
        targets = y.values.astype(float)
        mask = np.isfinite(preds) & np.isfinite(targets)
        return preds[mask].astype(float), targets[mask].astype(float)
    except Exception:
        return np.zeros((0,)), np.zeros((0,))


def _fit_isotonic(preds: np.ndarray, actuals: np.ndarray) -> IsotonicRegression | None:
    """Fit IsotonicRegression(actual ~ pred). Return None if too few rows."""
    if len(preds) < _MIN_ISO_ROWS:
        return None
    try:
        iso = IsotonicRegression(
            increasing=True,
            out_of_bounds="clip",  # extrapolate by clamping at endpoints
        )
        iso.fit(preds, actuals)
        return iso
    except Exception:
        return None


def _apply_iso(
    iso: IsotonicRegression | None,
    base_pred_mom: float,
    base_pred_lo_mom: float,
    base_pred_hi_mom: float,
) -> tuple[float, float, float, float]:
    """Apply isotonic correction to base predictions.

    Returns (calibrated_pred, calibrated_lo, calibrated_hi, raw_shift).
    The shift = f(base) - base is clipped to [-_ISO_CLIP_DELTA,
    _ISO_CLIP_DELTA] so calibration cannot swing the prediction wildly
    when training data is sparse near the test point. Bands shift by the
    same scalar, preserving quantile widths.
    """
    if iso is None:
        return base_pred_mom, base_pred_lo_mom, base_pred_hi_mom, 0.0
    try:
        calibrated = float(iso.predict(np.asarray([base_pred_mom], dtype=float))[0])
    except Exception:
        return base_pred_mom, base_pred_lo_mom, base_pred_hi_mom, 0.0

    raw_shift = calibrated - base_pred_mom
    shift = float(np.clip(raw_shift, -_ISO_CLIP_DELTA, _ISO_CLIP_DELTA))
    new_mid = base_pred_mom + shift
    new_lo = base_pred_lo_mom + shift
    new_hi = base_pred_hi_mom + shift
    return new_mid, new_lo, new_hi, raw_shift


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_isotonic_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of clev_nowcast + post-hoc isotonic calibration."""
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

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # --- isotonic calibration on in-sample (pred, actual) pairs ---
            iso_preds, iso_actuals = _build_iso_pairs(X, y, models)
            iso = _fit_isotonic(iso_preds, iso_actuals)

            # --- inference features (same as clev_nowcast) ---
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
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

            mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
            mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # --- apply isotonic ---
            mid_cal, lo_cal, hi_cal, raw_shift = _apply_iso(
                iso, mid_base, lo_base, hi_base,
            )
            mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(mid_cal, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid_cal)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom_base": round(mid_base, 4),
                "pred_mom": round(mid_cal, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "iso_shift": round(raw_shift, 4),
                "n_iso_rows": int(len(iso_preds)),
            })
        except Exception:
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


def run_isotonic_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> IsotonicNowcastResult:
    """Live nowcast with post-hoc isotonic calibration on the clev base model."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    iso_preds, iso_actuals = _build_iso_pairs(X, y, models)
    iso = _fit_isotonic(iso_preds, iso_actuals)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
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
    mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
    mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

    mid_cal, lo_cal, hi_cal, raw_shift = _apply_iso(iso, mid_base, lo_base, hi_base)
    mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid_cal, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_cal, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_cal, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return IsotonicNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        iso_shift_mom=raw_shift,
        n_iso_rows=int(len(iso_preds)),
    )
