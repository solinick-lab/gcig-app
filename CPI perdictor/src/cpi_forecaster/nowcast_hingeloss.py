"""Hinge-loss CPI nowcaster.

Goal: maximize hit-rate within +/-0.25pp YoY (24/24 = 100%) on the 24-month
backtest. Standard quantile/MSE losses minimize *average* error, but our
metric is the COUNT of errors > 0.25pp. So we train an XGBoost regressor
with a custom hinge-style objective:

    loss(y, yhat) = max(0, |y - yhat|^2 - threshold^2)

This is ZERO inside the +/-threshold band and grows quadratically beyond.
We work in MoM space so the YoY 0.25pp threshold maps to roughly 0.05% MoM
(after the standard MoM->YoY conversion through the CPI level).

Pipeline:
  1. Reuse Yellen-1.1 (clev_calibrated) feature set via _build_supervised_clev.
  2. Train XGBoost with the hinge custom objective on (X, y_mom).
  3. ALSO fit Yellen-1.1's GBR quantile median as a fallback / blend
     anchor (when XGB drifts the hinge model can drift far on regime
     shifts since gradients are zero inside the band — we anchor to GBR
     median if the hinge prediction's distance from GBR median exceeds a
     small clip).
  4. Convert MoM -> YoY in the standard way; bands from training residual
     std (since custom objective doesn't yield quantiles directly).

Public API:
  backtest_hingeloss_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_hingeloss_nowcast(as_of_day=20) -> HingelossNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5]. If XGBoost is
unavailable for any reason, gracefully falls back to the GBR median
prediction so the nowcaster still functions.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

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

# YoY-space target band.
_HIT_BAND_YOY = 0.25
# MoM-space equivalent. A 0.25pp YoY error after a 12-month aggregation
# scales roughly like a 0.05pp MoM single-month deviation when we hold the
# prior 11 months fixed. We use this as the hinge threshold.
_MOM_HINGE_THRESHOLD = 0.05

# Clip how far the hinge model can deviate from the GBR median (MoM space).
# Hinge gradients are zero inside the band so the optimum is "any point in
# the band" -- without an anchor the predictions can wander on regime
# shifts. We clip the hinge prediction to within +/- _ANCHOR_CLIP of the
# GBR median.
_ANCHOR_CLIP = 0.30

_XGB_PARAMS = dict(
    eta=0.05,
    max_depth=3,
    min_child_weight=1.0,
    subsample=0.9,
    colsample_bytree=0.9,
    reg_lambda=1.0,
    base_score=0.20,
    verbosity=0,
)
_XGB_NUM_ROUNDS = 400


@dataclass
class HingelossNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_xgb: bool


# ---------------------------------------------------------------------------
# Custom objective + safe XGBoost trainer
# ---------------------------------------------------------------------------


def _hinge_obj_factory(threshold: float = _MOM_HINGE_THRESHOLD):
    """Build the custom hinge objective for xgb.train.

    loss = max(0, diff^2 - threshold^2),  diff = predt - y
    grad = 2*diff if |diff| > threshold else 0
    hess = 2     if |diff| > threshold else tiny floor (XGB needs >0)

    A small positive floor on the hessian is needed because XGBoost uses
    hess to compute leaf weights and zero hess can degenerate splits.
    """

    def hinge_obj(predt, dtrain):
        try:
            y = dtrain.get_label()
            diff = np.asarray(predt, dtype=float) - np.asarray(y, dtype=float)
            outside = np.abs(diff) > threshold
            grad = np.where(outside, 2.0 * diff, 0.0)
            hess = np.where(outside, 2.0, 1e-3)
            return grad, hess
        except Exception:
            n = len(predt)
            return np.zeros(n), np.full(n, 1e-3)

    return hinge_obj


def _try_train_xgb(X: pd.DataFrame, y: pd.Series):
    """Train XGBoost with the hinge objective. Returns (booster, ok).

    Wraps every line — XGBoost might not be installed, or training might
    fail on a degenerate fold. Caller falls back to the GBR median
    prediction in that case.
    """
    try:
        import xgboost as xgb  # type: ignore
    except Exception:
        return None, False

    try:
        Xv = X.values.astype(float)
        yv = y.values.astype(float)
        dtrain = xgb.DMatrix(Xv, label=yv)
        obj = _hinge_obj_factory(_MOM_HINGE_THRESHOLD)
        booster = xgb.train(
            params=_XGB_PARAMS,
            dtrain=dtrain,
            num_boost_round=_XGB_NUM_ROUNDS,
            obj=obj,
        )
        return booster, True
    except Exception:
        return None, False


def _safe_xgb_predict(booster, x_inf_values: np.ndarray) -> float | None:
    try:
        import xgboost as xgb  # type: ignore
        d = xgb.DMatrix(x_inf_values.reshape(1, -1))
        pred = float(np.asarray(booster.predict(d)).ravel()[0])
        if not np.isfinite(pred):
            return None
        return pred
    except Exception:
        return None


def _residual_std(booster, X: pd.DataFrame, y: pd.Series, fallback_mom: float = 0.15) -> float:
    """Std of in-sample residuals — used to set 80% bands when XGB is used."""
    try:
        import xgboost as xgb  # type: ignore
        d = xgb.DMatrix(X.values.astype(float))
        pred = np.asarray(booster.predict(d)).ravel()
        resid = pred - y.values.astype(float)
        s = float(np.std(resid, ddof=1)) if len(resid) > 1 else fallback_mom
        if not np.isfinite(s) or s <= 0:
            return fallback_mom
        return s
    except Exception:
        return fallback_mom


def _blend_with_anchor(hinge_mom: float, gbr_mom: float, clip: float = _ANCHOR_CLIP) -> float:
    """Clip hinge prediction to be within +/- clip of GBR median anchor.

    Hinge gradients are zero inside the +/- threshold band so the optimum
    is degenerate — without an anchor a regime shift can pull the model
    far from any sensible value. The clip keeps it close to the
    well-behaved median model.
    """
    try:
        delta = float(hinge_mom) - float(gbr_mom)
        delta = float(np.clip(delta, -clip, clip))
        return float(gbr_mom + delta)
    except Exception:
        return float(gbr_mom)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_hingeloss_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the hinge-loss XGBoost nowcaster."""
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
    used_xgb_any = False

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

            # Anchor: GBR quantile median (Yellen-1.1's base predictor).
            try:
                gbr_models = _fit_quantile_models(X, y)
            except Exception:
                gbr_models = None

            # Hinge-loss XGBoost.
            booster, ok_xgb = _try_train_xgb(X, y)
            if ok_xgb:
                used_xgb_any = True

            cols = list(X.columns)

            # Inference features (same recipe as Yellen 1.1).
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
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            try:
                feats["cpi_yoy_lag1"] = float(
                    (train_panel[TARGET.fred_id].dropna().iloc[-1]
                     / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
                )
            except Exception:
                feats["cpi_yoy_lag1"] = np.nan
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            # Anchor prediction.
            try:
                if gbr_models is not None:
                    gbr_mid, gbr_lo, gbr_hi = _predict_triple(gbr_models, x_inf, cols)
                else:
                    gbr_mid, gbr_lo, gbr_hi = 0.20, 0.05, 0.35
            except Exception:
                gbr_mid, gbr_lo, gbr_hi = 0.20, 0.05, 0.35
            gbr_mid = float(np.clip(gbr_mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Hinge prediction.
            hinge_mom = None
            if ok_xgb and booster is not None:
                hinge_mom = _safe_xgb_predict(
                    booster, x_inf.values.astype(float)
                )

            if hinge_mom is None:
                # Fallback: just use the GBR median.
                final_mom = gbr_mid
                lo_mom, hi_mom = gbr_lo, gbr_hi
            else:
                final_mom = _blend_with_anchor(hinge_mom, gbr_mid, _ANCHOR_CLIP)
                # Bands from in-sample residual std (XGB doesn't give quantiles).
                try:
                    sigma_mom = _residual_std(booster, X, y, fallback_mom=0.15)
                except Exception:
                    sigma_mom = 0.15
                # 80% normal-z ~= 1.2816
                lo_mom = final_mom - 1.2816 * sigma_mom
                hi_mom = final_mom + 1.2816 * sigma_mom

            final_mom = float(np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(final_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(final_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom_hinge": round(float(hinge_mom), 4) if hinge_mom is not None else None,
                "pred_mom_anchor": round(gbr_mid, 4),
                "pred_mom": round(final_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "used_xgb": bool(ok_xgb and hinge_mom is not None),
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
        "usedXgbAny": used_xgb_any,
        "rows": rows,
    }


def run_hingeloss_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> HingelossNowcastResult:
    """Live hinge-loss XGBoost nowcast for the next unreleased month."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    cols = list(X.columns)

    # Anchor model.
    try:
        gbr_models = _fit_quantile_models(X, y)
    except Exception:
        gbr_models = None

    # Hinge-loss XGBoost.
    booster, ok_xgb = _try_train_xgb(X, y)

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
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2]) if len(y_mom) >= 2 else np.nan
    try:
        feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    except Exception:
        feats["cpi_yoy_lag1"] = np.nan
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

    # Anchor prediction.
    try:
        if gbr_models is not None:
            gbr_mid, gbr_lo, gbr_hi = _predict_triple(gbr_models, x_inf, cols)
        else:
            gbr_mid, gbr_lo, gbr_hi = 0.20, 0.05, 0.35
    except Exception:
        gbr_mid, gbr_lo, gbr_hi = 0.20, 0.05, 0.35
    gbr_mid = float(np.clip(gbr_mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    hinge_mom = None
    if ok_xgb and booster is not None:
        hinge_mom = _safe_xgb_predict(booster, x_inf.values.astype(float))

    if hinge_mom is None:
        final_mom = gbr_mid
        lo_mom, hi_mom = gbr_lo, gbr_hi
        used_xgb = False
    else:
        final_mom = _blend_with_anchor(hinge_mom, gbr_mid, _ANCHOR_CLIP)
        try:
            sigma_mom = _residual_std(booster, X, y, fallback_mom=0.15)
        except Exception:
            sigma_mom = 0.15
        lo_mom = final_mom - 1.2816 * sigma_mom
        hi_mom = final_mom + 1.2816 * sigma_mom
        used_xgb = True

    final_mom = float(np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(final_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return HingelossNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=final_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        used_xgb=used_xgb,
    )
