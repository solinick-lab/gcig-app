"""Hyperparameter-tuned version of clev_calibrated (Yellen 1.1).

Same architecture as nowcast_clev_calibrated but with a small grid search
over the GBR hyperparameters (n_estimators, max_depth, learning_rate).
For each backtest cut we hold out the LAST 6 rows of the supervised
training set as a validation slice, sweep the grid, and pick the config
with the lowest validation MAE on the median (q=0.5) point estimate. The
selected config is then refit on the FULL training set and used for the
quantile triple. The Ridge calibration layer is unchanged.

Grid (kept small intentionally — this is heavy):
  n_estimators   in {200, 400, 800}
  max_depth      in {2, 3, 4, 5}
  learning_rate  in {0.03, 0.05, 0.10}

Public API:
  backtest_tuned_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_tuned_nowcast(as_of_day=20) -> TunedNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
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
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
    _QUANTILES,
)
from .nowcast_clev_calibrated import (
    _build_calibration_dataset,
    _fit_calibrator,
    _apply_calibration,
    _recent_vol,
)


warnings.filterwarnings("ignore")


# --- grid search constants ----------------------------------------------

_N_ESTIMATORS_GRID = (200, 400, 800)
_MAX_DEPTH_GRID = (2, 3, 4, 5)
_LEARNING_RATE_GRID = (0.03, 0.05, 0.10)
_VAL_HOLDOUT = 6  # last 6 rows of supervised training set
_DEFAULT_GBR = dict(n_estimators=400, max_depth=3, learning_rate=0.05, random_state=42)


@dataclass
class TunedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    bias_shift_mom: float
    n_calib_rows: int
    best_n_estimators: int
    best_max_depth: int
    best_learning_rate: float
    val_mae: float


# ---------------------------------------------------------------------------
# Hyperparameter search
# ---------------------------------------------------------------------------


def _grid_search_gbr(X: pd.DataFrame, y: pd.Series) -> tuple[dict, float]:
    """Grid-search GBR hyperparameters using last `_VAL_HOLDOUT` rows
    of (X, y) as a validation slice. Optimises validation MAE on the
    MEDIAN point estimate (squared loss). Returns (best_params, best_mae).

    Falls back to the default config if the dataset is too small to
    leave a meaningful validation slice.
    """
    n = len(X)
    if n < (_VAL_HOLDOUT + 12):
        return dict(_DEFAULT_GBR), float("nan")

    Xv = X.values
    yv = y.values
    X_tr, X_va = Xv[:-_VAL_HOLDOUT], Xv[-_VAL_HOLDOUT:]
    y_tr, y_va = yv[:-_VAL_HOLDOUT], yv[-_VAL_HOLDOUT:]

    best = dict(_DEFAULT_GBR)
    best_mae = float("inf")

    for n_est in _N_ESTIMATORS_GRID:
        for md in _MAX_DEPTH_GRID:
            for lr in _LEARNING_RATE_GRID:
                params = dict(
                    n_estimators=int(n_est),
                    max_depth=int(md),
                    learning_rate=float(lr),
                    random_state=42,
                )
                try:
                    # Use squared-loss GBR for the validation criterion
                    # (matches how we judge "point" prediction error).
                    m = GradientBoostingRegressor(**params).fit(X_tr, y_tr)
                    preds = m.predict(X_va)
                    mae = float(np.mean(np.abs(preds - y_va)))
                except Exception:
                    continue
                if mae < best_mae:
                    best_mae = mae
                    best = params

    if not np.isfinite(best_mae):
        return dict(_DEFAULT_GBR), float("nan")
    return best, best_mae


def _fit_quantile_models_tuned(X: pd.DataFrame, y: pd.Series, params: dict) -> dict:
    """Fit q={0.1, 0.5, 0.9} GBR with the tuned `params`."""
    models: dict = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **params,
        ).fit(X.values, y.values)
    return models


def _predict_triple_local(models: dict, x_inf: pd.Series, cols: list[str]) -> tuple[float, float, float]:
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    preds = sorted(float(models[q].predict(aligned)[0]) for q in _QUANTILES)
    lo, mid, hi = preds
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_tuned_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of clev base + grid-searched GBR + Ridge calib."""
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

            # --- grid search GBR on last 6 rows ---
            best_params, val_mae = _grid_search_gbr(X, y)

            # --- fit quantile models with tuned params on FULL training set ---
            models = _fit_quantile_models_tuned(X, y, best_params)
            cols = list(X.columns)

            # --- calibration on in-sample (clev_pred, actual) pairs ---
            train_y_mom = build_target(train_panel).dropna()
            F_cal, t_cal = _build_calibration_dataset(
                X, y, models, cols, train_panel, train_y_mom
            )
            ridge = _fit_calibrator(F_cal, t_cal)

            # --- inference features ---
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

            mid_base, lo_base, hi_base = _predict_triple_local(models, x_inf, cols)
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
                "best_n_estimators": int(best_params.get("n_estimators", 0)),
                "best_max_depth": int(best_params.get("max_depth", 0)),
                "best_learning_rate": float(best_params.get("learning_rate", 0.0)),
                "val_mae": round(float(val_mae), 4) if np.isfinite(val_mae) else None,
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


def run_tuned_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> TunedNowcastResult:
    """Live nowcast: clev base + grid-searched GBR + Ridge calibration."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)

    best_params, val_mae = _grid_search_gbr(X, y)
    models = _fit_quantile_models_tuned(X, y, best_params)
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
    mid_base, lo_base, hi_base = _predict_triple_local(models, x_inf, cols)
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
    return TunedNowcastResult(
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
        best_n_estimators=int(best_params.get("n_estimators", 0)),
        best_max_depth=int(best_params.get("max_depth", 0)),
        best_learning_rate=float(best_params.get("learning_rate", 0.0)),
        val_mae=float(val_mae) if np.isfinite(val_mae) else float("nan"),
    )
