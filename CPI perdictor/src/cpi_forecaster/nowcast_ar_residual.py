"""AR-on-residuals nowcaster: Yellen 1.1 plus an AR(2) correction on its
in-sample residual series.

Hypothesis: Yellen 1.1 (clev_calibrated) is a strong base, but the
residual sequence (actual_mom - pred_mom on the in-sample training rows)
may still carry some autocorrelation — months where the model just
recently undershot have a small but exploitable tendency to undershoot
again, and vice versa. A small AR(2) on those residuals captures that
short-memory bias without overfitting.

Approach:
  1. Run Yellen 1.1 internals on the training panel (build supervised
     dataset, fit the quantile models, fit the Ridge calibrator).
  2. For every training row, compute the IN-SAMPLE residual
        r_t = y_t - yellen_pred_t
     where yellen_pred_t is the (calibrated, clipped) MoM prediction the
     same model would give if asked to predict the training row.
  3. Sort residuals by their target month timestamp into a time series
     and fit an AR(2) model via statsmodels' AutoReg.
  4. Forecast the next residual r_hat. Add it to Yellen 1.1's live
     MoM prediction (and shift the 80% band endpoints by the same
     amount so widths are preserved).
  5. Convert to YoY for reporting.

Public API mirrors nowcast_clev_calibrated:
  backtest_ar_residual_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_ar_residual_nowcast(as_of_day=20) -> ARResidualNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5]. The added
residual contribution is itself clipped to a small magnitude so the AR
correction can never wildly override the base model.
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
from .nowcast_clev_calibrated import (
    _build_calibration_dataset,
    _fit_calibrator,
    _apply_calibration,
    _recent_vol,
    _CALIB_CLIP_DELTA,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_AR_LAGS = 2                       # AR(2) by spec
_MIN_RESID_ROWS = 24               # need a decent residual history for AR(2)
_AR_SHIFT_CLIP = _CALIB_CLIP_DELTA # cap |r_hat| in MoM space (same scale as calib clip)


@dataclass
class ARResidualNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    yellen_pred_mom: float
    ar_residual_shift_mom: float
    n_resid_rows: int


# ---------------------------------------------------------------------------
# AR(2) on residuals
# ---------------------------------------------------------------------------


def _yellen_in_sample_preds(
    X: pd.DataFrame,
    y: pd.Series,
    models: dict,
    cols: list[str],
    train_y_mom: pd.Series,
    panel: pd.DataFrame,
) -> pd.Series:
    """Compute Yellen 1.1's in-sample MoM predictions for every training row.

    Mirrors the full pipeline: median quantile prediction -> calibration ->
    clip. Index is the target month-end of each training row, values are
    the calibrated, clipped MoM prediction. Used to derive residuals for
    the AR model.
    """
    if len(X) == 0:
        return pd.Series(dtype=float)

    # Step 1: base median quantile predictions
    Xv = X.values
    median_model = models[0.5]
    base_preds = median_model.predict(Xv).astype(float)

    # Step 2: fit Ridge calibrator on the (pred, actual) pairs
    F_cal, t_cal = _build_calibration_dataset(
        X, y, models, cols, panel, train_y_mom
    )
    ridge = _fit_calibrator(F_cal, t_cal)

    # Step 3: derive the in-sample calibrated MoM predictions (apply the
    # same Ridge correction to each base prediction). We construct the
    # calibration features per row (pred_i, vol_i, yml_i) directly so the
    # in-sample preds are consistent with the live inference path.
    if "clev_yoy_minus_lag" in X.columns:
        yml_arr = X["clev_yoy_minus_lag"].values.astype(float)
    else:
        yml_arr = np.zeros(len(X), dtype=float)

    out = np.empty(len(X), dtype=float)
    for i, idx in enumerate(X.index):
        try:
            base = float(base_preds[i])
            vol_i = _recent_vol(train_y_mom, idx)
            yml_i = float(yml_arr[i]) if np.isfinite(yml_arr[i]) else 0.0
            cal, _lo, _hi, _shift = _apply_calibration(
                ridge, base, base, base, vol_i, yml_i,
            )
            out[i] = float(np.clip(cal, _MOM_LO_CLIP, _MOM_HI_CLIP))
        except Exception:
            out[i] = float(np.clip(base_preds[i], _MOM_LO_CLIP, _MOM_HI_CLIP))

    return pd.Series(out, index=X.index, dtype=float).sort_index()


def _fit_ar2_and_forecast(resid_series: pd.Series) -> tuple[float, int]:
    """Fit AR(2) on the (sorted) residual series and forecast the next step.

    Returns (r_hat, n_used). `r_hat` is clipped to ±_AR_SHIFT_CLIP. On
    failure (too few rows, fit error) returns (0.0, n_used) so the
    prediction reduces gracefully to plain Yellen 1.1.
    """
    s = resid_series.dropna()
    if len(s) < _MIN_RESID_ROWS:
        return 0.0, int(len(s))

    try:
        from statsmodels.tsa.ar_model import AutoReg

        # We pass the values rather than relying on the index frequency,
        # which avoids statsmodels' frequency-inference warnings for
        # irregular indices. AR(2) on a length-n vector is well-posed for
        # n >= 3; we already require >= _MIN_RESID_ROWS.
        vals = np.asarray(s.values, dtype=float)
        if not np.all(np.isfinite(vals)):
            vals = vals[np.isfinite(vals)]
            if len(vals) < _MIN_RESID_ROWS:
                return 0.0, int(len(vals))

        model = AutoReg(vals, lags=_AR_LAGS, old_names=False)
        fit = model.fit()
        # Forecast the very next step (one-step ahead).
        fcst = fit.forecast(steps=1)
        r_hat = float(np.asarray(fcst).ravel()[0])
        if not np.isfinite(r_hat):
            return 0.0, int(len(vals))
        r_hat = float(np.clip(r_hat, -_AR_SHIFT_CLIP, _AR_SHIFT_CLIP))
        return r_hat, int(len(vals))
    except Exception:
        return 0.0, int(len(s))


# ---------------------------------------------------------------------------
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_ar_residual_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of Yellen 1.1 + AR(2)-on-residuals correction.

    For each held-out target month: fit Yellen 1.1 on data strictly before
    the target, compute its in-sample residuals, fit AR(2) on that residual
    series, forecast the next residual, and add it to Yellen 1.1's live
    prediction for the held-out month.
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

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            train_y_mom = build_target(train_panel).dropna()

            # --- in-sample Yellen preds & residuals ---
            yellen_in_sample = _yellen_in_sample_preds(
                X, y, models, cols, train_y_mom, train_panel,
            )
            if len(yellen_in_sample) == 0:
                continue
            # residuals = actual - prediction, aligned on training row index
            resid = (y.reindex(yellen_in_sample.index) - yellen_in_sample).dropna()
            r_hat, n_resid = _fit_ar2_and_forecast(resid)

            # --- Live Yellen 1.1 inference (same recipe as clev_calibrated) ---
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = train_y_mom
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            cpi_train = train_panel[TARGET.fred_id].dropna()
            feats["cpi_yoy_lag1"] = float(
                (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
            mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
            mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

            inf_vol = _recent_vol(train_y_mom, target_month_end)
            inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
            if not np.isfinite(inf_yml):
                inf_yml = 0.0

            # Refit calibrator (same data the in-sample step used) for the
            # live point so we keep the Yellen 1.1 contract intact.
            F_cal, t_cal = _build_calibration_dataset(
                X, y, models, cols, train_panel, train_y_mom
            )
            ridge = _fit_calibrator(F_cal, t_cal)

            mid_yellen, lo_yellen, hi_yellen, _bs = _apply_calibration(
                ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
            )
            mid_yellen = float(np.clip(mid_yellen, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # --- Apply the AR(2) residual correction ---
            mid_final = float(np.clip(mid_yellen + r_hat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            lo_final = lo_yellen + r_hat
            hi_final = hi_yellen + r_hat

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(cpi_train.iloc[-1])
            pred_yoy = _mom_to_yoy(mid_final, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid_final)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom_yellen": round(mid_yellen, 4),
                "ar_resid_shift": round(r_hat, 4),
                "pred_mom": round(mid_final, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_resid_rows": int(n_resid),
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


def run_ar_residual_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ARResidualNowcastResult:
    """Live nowcast: Yellen 1.1 prediction plus AR(2)-on-residuals shift."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    y_mom = build_target(panel).dropna()

    # In-sample Yellen preds & residuals -> AR(2) -> r_hat
    yellen_in_sample = _yellen_in_sample_preds(X, y, models, cols, y_mom, panel)
    resid = (y.reindex(yellen_in_sample.index) - yellen_in_sample).dropna()
    r_hat, n_resid = _fit_ar2_and_forecast(resid)

    # Calibrator for the live point
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

    mid_yellen, lo_yellen, hi_yellen, _bs = _apply_calibration(
        ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_yellen = float(np.clip(mid_yellen, _MOM_LO_CLIP, _MOM_HI_CLIP))

    # AR shift
    mid_final = float(np.clip(mid_yellen + r_hat, _MOM_LO_CLIP, _MOM_HI_CLIP))
    lo_final = lo_yellen + r_hat
    hi_final = hi_yellen + r_hat

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid_final, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_final, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_final, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return ARResidualNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_final,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        yellen_pred_mom=mid_yellen,
        ar_residual_shift_mom=r_hat,
        n_resid_rows=int(n_resid),
    )
