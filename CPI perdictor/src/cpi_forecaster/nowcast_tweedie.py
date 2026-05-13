"""Tweedie-regression nowcaster (compound Poisson-Gamma point estimate).

Hypothesis: CPI MoM has heavier-than-Gaussian tails (occasional spikes
from energy/food), so a model with a heavier-tailed conditional density
should beat squared-error / quantile median on RMSE-YoY. The Tweedie
distribution with power=1.5 is a compound Poisson-Gamma — strictly
positive, right-skewed, and naturally accommodates "small most of the
time, occasionally larger" behavior.

Mechanics:
  1. Reuse Yellen 1.1's feature set:
        _build_supervised_clev → quantile_rich + Cleveland features
  2. Add a constant offset (+_TWEEDIE_OFFSET) to MoM so the target is
     strictly positive (Tweedie requires y >= 0; with power=1.5 fitting
     fails or is unstable on negatives). At inference we subtract the
     offset back out.
  3. Fit `TweedieRegressor(power=1.5, link='log')` on (X, y_mom + offset).
     The mean of a compound Poisson-Gamma is right-skewed, so the
     conditional mean naturally pulls toward the right tail when energy/
     food momentum signals are elevated.
  4. For 80% bands we still need quantile estimates — Tweedie gives a
     point prediction. Reuse Yellen 1.1's q=0.1/q=0.9 GBR quantile
     models for the bands but recenter them on the Tweedie point so the
     band-shape is preserved.
  5. Apply the same Yellen 1.1 Ridge bias-correction calibrator on top
     of the Tweedie point estimate (calibration is purely a linear
     residual-correction so it composes cleanly with any base model).

Public API:
  backtest_tweedie_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_tweedie_nowcast(as_of_day=20) -> TweedieNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import TweedieRegressor

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
from .nowcast_clev_calibrated import (
    _build_calibration_dataset,
    _fit_calibrator,
    _apply_calibration,
    _recent_vol,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

# Constant offset added to MoM so target is strictly positive (Tweedie
# with power in (1, 2) requires y >= 0). Headline CPI MoM has a
# historical floor near -1.6pp during the 2008 oil collapse, so +5.0
# leaves a safe non-zero margin for any plausible future month.
_TWEEDIE_OFFSET = 5.0

# Tweedie hyperparameters: power=1.5 is compound Poisson-Gamma. Use the
# log link so predictions stay positive and we get multiplicative effects
# in MoM-space (heavier-tailed than identity link). Mild ridge shrinkage
# stabilizes coefficients on the (~150-month) training window.
_TWEEDIE_PARAMS = dict(
    power=1.5,
    alpha=0.5,
    link="log",
    max_iter=2000,
    tol=1e-6,
)


@dataclass
class TweedieNowcastResult:
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


# ---------------------------------------------------------------------------
# Tweedie fit / predict
# ---------------------------------------------------------------------------


def _fit_tweedie(X: pd.DataFrame, y: pd.Series) -> TweedieRegressor:
    """Fit TweedieRegressor on (y + offset) so the target is strictly positive."""
    y_shifted = y.values.astype(float) + _TWEEDIE_OFFSET
    # Defensive: clamp any residual non-positive values (very unlikely
    # given the +5.0 offset) so the fit doesn't blow up.
    y_shifted = np.maximum(y_shifted, 1e-6)
    model = TweedieRegressor(**_TWEEDIE_PARAMS)
    model.fit(X.values, y_shifted)
    return model


def _predict_tweedie(model: TweedieRegressor, x_inf: pd.Series, cols: list[str]) -> float:
    """Predict MoM (after subtracting the offset back out)."""
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    pred_shifted = float(model.predict(aligned)[0])
    return pred_shifted - _TWEEDIE_OFFSET


# ---------------------------------------------------------------------------
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_tweedie_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of Tweedie nowcaster on Yellen 1.1's feature set."""
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

            # --- fit Tweedie point estimator + GBR for quantile bands ---
            tweedie = _fit_tweedie(X, y)
            qmodels = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # --- calibration dataset uses Tweedie as the base predictor ---
            train_y_mom = build_target(train_panel).dropna()
            # Repackage Tweedie predictions as the "median model" expected
            # by _build_calibration_dataset. We construct a tiny shim: the
            # function only calls models[0.5].predict(Xv) for in-sample
            # preds, so we wrap Tweedie behind that interface.
            class _TweedieShim:
                def predict(self_inner, Xv):  # noqa: ARG002, N805
                    raw = tweedie.predict(Xv)
                    return raw - _TWEEDIE_OFFSET
            shim_models = {0.5: _TweedieShim()}
            F_cal, t_cal = _build_calibration_dataset(
                X, y, shim_models, cols, train_panel, train_y_mom
            )
            ridge = _fit_calibrator(F_cal, t_cal)

            # --- inference features (identical to Yellen 1.1) ---
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

            # Tweedie point estimate (in MoM space, after offset)
            mid_tw = _predict_tweedie(tweedie, x_inf, cols)
            mid_tw = float(np.clip(mid_tw, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # GBR-based 80% bands; recenter on Tweedie so the band shape
            # carries over (q=0.1, q=0.9 widths kept; midpoint replaced).
            mid_q, lo_q, hi_q = _predict_triple(qmodels, x_inf, cols)
            band_lo_offset = lo_q - mid_q
            band_hi_offset = hi_q - mid_q
            lo_base = mid_tw + band_lo_offset
            hi_base = mid_tw + band_hi_offset

            # --- apply calibration on top of the Tweedie point ---
            inf_vol = _recent_vol(train_y_mom, target_month_end)
            inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
            if not np.isfinite(inf_yml):
                inf_yml = 0.0

            mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
                ridge, mid_tw, lo_base, hi_base, inf_vol, inf_yml,
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
                "pred_mom_tweedie": round(mid_tw, 4),
                "pred_mom": round(mid_cal, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "bias_shift": round(bias_shift, 4),
                "n_calib_rows": int(len(F_cal)),
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


# ---------------------------------------------------------------------------
# Public API: live nowcast
# ---------------------------------------------------------------------------


def run_tweedie_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> TweedieNowcastResult:
    """Live nowcast: TweedieRegressor on Yellen 1.1 features + Ridge calibration."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    tweedie = _fit_tweedie(X, y)
    qmodels = _fit_quantile_models(X, y)
    cols = list(X.columns)

    y_mom = build_target(panel).dropna()

    # Calibration on in-sample Tweedie residuals
    class _TweedieShim:
        def predict(self_inner, Xv):  # noqa: ARG002, N805
            raw = tweedie.predict(Xv)
            return raw - _TWEEDIE_OFFSET
    shim_models = {0.5: _TweedieShim()}
    F_cal, t_cal = _build_calibration_dataset(X, y, shim_models, cols, panel, y_mom)
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
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2]) if len(y_mom) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

    mid_tw = _predict_tweedie(tweedie, x_inf, cols)
    mid_tw = float(np.clip(mid_tw, _MOM_LO_CLIP, _MOM_HI_CLIP))

    mid_q, lo_q, hi_q = _predict_triple(qmodels, x_inf, cols)
    band_lo_offset = lo_q - mid_q
    band_hi_offset = hi_q - mid_q
    lo_base = mid_tw + band_lo_offset
    hi_base = mid_tw + band_hi_offset

    inf_vol = _recent_vol(y_mom, target_month_end)
    inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
    if not np.isfinite(inf_yml):
        inf_yml = 0.0

    mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
        ridge, mid_tw, lo_base, hi_base, inf_vol, inf_yml,
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
    return TweedieNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        bias_shift_mom=float(bias_shift),
        n_calib_rows=int(len(F_cal)),
    )
