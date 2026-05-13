"""Post-hoc calibration layer on top of clev_nowcast.

Hypothesis: clev_nowcast may have systematic bias on certain regimes
(overshoots during disinflation, undershoots during re-acceleration). A
tiny linear correction (3-4 params) trained on its historical residuals
should remove that bias without changing the base model.

Approach:
  1. For each backtest cut, run the base clev_nowcast pipeline on the
     training window. Collect (clev_pred_mom, actual_mom) pairs from
     in-sample residuals (the model fitted on the training data and
     evaluated on the SAME training rows — calibration learns the
     in-sample bias structure that the model carries into OOS).
  2. Fit a Ridge regression with at most 4 features:
        actual_mom = alpha + beta*clev_pred + gamma*recent_vol + delta*(last_yoy - actual)
     We approximate "last_yoy - actual" by `clev_yoy_minus_lag` style
     momentum proxy at training time so the calibrator learns when the
     base model tends to over/undershoot vs. inflation regime.
  3. Apply the correction to the live clev prediction.
  4. 80% bands: shift clev's lo/hi by the same MoM-space alpha bias
     correction (re-converted to YoY at inference).

Public API:
  backtest_clev_calibrated_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_clev_calibrated_nowcast(as_of_day=20) -> ClevCalibratedNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge

from .api_client import get_daily_panel, get_cleveland_nowcast
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

_RIDGE_ALPHA = 1.0  # mild regularization — tiny model, want strong shrinkage
_VOL_WINDOW = 6     # recent MoM volatility window (months)
_MIN_CALIB_ROWS = 18  # need a decent history of (pred, actual) pairs
_CALIB_CLIP_DELTA = 0.30  # limit how much calibration can shift base pred (MoM space)


@dataclass
class ClevCalibratedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    bias_shift_mom: float  # how much calibration shifted base pred
    n_calib_rows: int


# ---------------------------------------------------------------------------
# Calibration helpers
# ---------------------------------------------------------------------------


def _recent_vol(y_mom_history: pd.Series, asof_idx: pd.Timestamp, window: int = _VOL_WINDOW) -> float:
    """Std of MoM over the last `window` months strictly BEFORE asof_idx."""
    try:
        prior = y_mom_history.loc[y_mom_history.index < asof_idx]
        if len(prior) < 2:
            return 0.0
        tail = prior.iloc[-window:]
        if len(tail) < 2:
            return 0.0
        return float(np.std(tail.values, ddof=1))
    except Exception:
        return 0.0


def _build_calibration_dataset(
    X: pd.DataFrame,
    y: pd.Series,
    models: dict,
    cols: list[str],
    panel: pd.DataFrame,
    y_mom_full: pd.Series,
) -> tuple[np.ndarray, np.ndarray]:
    """Build (features, target) for the Ridge calibrator.

    For each training row we already have (X_i, y_i). We compute the
    base model's median quantile prediction (pred_i) on that row
    (in-sample), then assemble the calibration features:
        [pred_i, recent_vol_i, clev_yoy_minus_lag_i]
    This is a 3-feature linear correction (plus intercept = 4 params).
    """
    feats_list: list[list[float]] = []
    targets: list[float] = []

    if len(X) == 0:
        return np.zeros((0, 3)), np.zeros((0,))

    Xv = X.values
    # Use the median quantile (q=0.5) as the point prediction
    median_model = models[0.5]
    preds_in_sample = median_model.predict(Xv)

    yoy_minus_lag_series = (
        X["clev_yoy_minus_lag"].values if "clev_yoy_minus_lag" in X.columns else np.zeros(len(X))
    )

    for i, idx in enumerate(X.index):
        try:
            pred_i = float(preds_in_sample[i])
            vol_i = _recent_vol(y_mom_full, idx)
            yml_i = float(yoy_minus_lag_series[i]) if np.isfinite(yoy_minus_lag_series[i]) else 0.0
            feats_list.append([pred_i, vol_i, yml_i])
            targets.append(float(y.iloc[i]))
        except Exception:
            continue

    if not feats_list:
        return np.zeros((0, 3)), np.zeros((0,))
    return np.asarray(feats_list, dtype=float), np.asarray(targets, dtype=float)


def _fit_calibrator(F: np.ndarray, t: np.ndarray) -> Ridge | None:
    """Fit Ridge on (F, t). Return None if too few rows."""
    if len(F) < _MIN_CALIB_ROWS:
        return None
    try:
        ridge = Ridge(alpha=_RIDGE_ALPHA, fit_intercept=True)
        ridge.fit(F, t)
        return ridge
    except Exception:
        return None


def _apply_calibration(
    ridge: Ridge | None,
    base_pred_mom: float,
    base_pred_lo_mom: float,
    base_pred_hi_mom: float,
    recent_vol: float,
    yoy_minus_lag: float,
) -> tuple[float, float, float, float]:
    """Apply the linear correction to base predictions.

    Returns (calibrated_pred, calibrated_lo, calibrated_hi, bias_shift).
    The bands are shifted by the same SCALAR bias correction
    (predicted_calibrated - predicted_base) so quantile widths are
    preserved (the calibrator only removes systematic bias; it does not
    re-estimate the conditional spread).
    """
    if ridge is None:
        return base_pred_mom, base_pred_lo_mom, base_pred_hi_mom, 0.0

    try:
        feat = np.asarray(
            [[base_pred_mom, float(recent_vol), float(yoy_minus_lag)]],
            dtype=float,
        )
        calibrated = float(ridge.predict(feat)[0])
    except Exception:
        return base_pred_mom, base_pred_lo_mom, base_pred_hi_mom, 0.0

    # Clip the SHIFT so calibration can never wildly override the base model
    raw_shift = calibrated - base_pred_mom
    shift = float(np.clip(raw_shift, -_CALIB_CLIP_DELTA, _CALIB_CLIP_DELTA))

    new_mid = base_pred_mom + shift
    new_lo = base_pred_lo_mom + shift
    new_hi = base_pred_hi_mom + shift
    return new_mid, new_lo, new_hi, shift


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_clev_calibrated_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of clev_nowcast + post-hoc Ridge calibration."""
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

            # --- calibration: fit Ridge on in-sample (clev_pred, actual) pairs ---
            train_y_mom = build_target(train_panel).dropna()
            F_cal, t_cal = _build_calibration_dataset(
                X, y, models, cols, train_panel, train_y_mom
            )
            ridge = _fit_calibrator(F_cal, t_cal)

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

            # --- apply calibration ---
            inf_vol = _recent_vol(train_y_mom, target_month_end)
            inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
            if not np.isfinite(inf_yml):
                inf_yml = 0.0

            mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
                ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
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
                "bias_shift": round(bias_shift, 4),
                "n_calib_rows": len(F_cal),
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


def run_clev_calibrated_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ClevCalibratedNowcastResult:
    """Live nowcast with post-hoc calibration on the clev base model."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    y_mom = build_target(panel).dropna()
    F_cal, t_cal = _build_calibration_dataset(X, y, models, cols, panel, y_mom)
    ridge = _fit_calibrator(F_cal, t_cal)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
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

    inf_vol = _recent_vol(y_mom, target_month_end)
    inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
    if not np.isfinite(inf_yml):
        inf_yml = 0.0

    mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
        ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
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
    return ClevCalibratedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        bias_shift_mom=bias_shift,
        n_calib_rows=int(len(F_cal)),
    )
