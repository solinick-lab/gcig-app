"""Acceleration-aware residual correction on top of Yellen 1.1.

Hypothesis: Yellen 1.1 (clev_calibrated) misses systematically when the
inflation regime is mid-shift — its biggest documented slip is January
2025 (+0.74pp during the disinflation pivot). Standard features describe
the LEVEL of the trend; this module instead computes ACCELERATION
features (changes in trend) that directly indicate when a regime shift is
under way:

  - CPI 3mo MoM avg minus 6mo MoM avg              (acceleration sign of CPI)
  - Cleveland Fed nowcast 5-day implied slope      (intra-month derivative)
  - Cleveland 14-day implied slope
  - Truflation YoY change in last 30 days          (private nowcast inflection)
  - Oil 14-day vs 60-day momentum (recent vs long acceleration)
  - Yield curve change in last 30 days             (T10Y2Y movement)
  - Cleveland slope-of-slope (acceleration of nowcast itself)

Architecture: SECOND-STAGE residual learning around Yellen 1.1.

  1. For each backtest cut, fit the base Yellen 1.1 pipeline (clev
     features + GBR quantile triple + Ridge calibrator) on the training
     window. Generate the IN-SAMPLE Yellen 1.1 predictions for every
     training month (after calibration is applied).
  2. Compute residuals: r_i = actual_mom_i - yellen_pred_mom_i.
  3. Build a separate "regime" feature matrix R for those same training
     months — only the acceleration features above. Strong regularization
     (Ridge alpha grid weighted heavily toward shrinkage) so the
     correction is conservative on small/noisy samples.
  4. Fit Ridge(R, r) → learns "given current regime indicators, how much
     does Yellen 1.1 typically miss by?"
  5. At inference: yellen_pred_mom + ridge.predict(regime_features) =
     final MoM. Convert to YoY via the same chain rule.

The residual correction is CLIPPED to [-0.30, 0.30] MoM-space so a
miscalibrated regime model can never wildly override the base; we only
WANT to remove the bias the base systematically carries during regime
shifts.

Public API (standard interface):
  backtest_accel_nowcast(panel, daily_frame, window_months=24,
                         as_of_day=20) -> dict
  run_accel_nowcast(as_of_day=20) -> AccelNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge, RidgeCV
from sklearn.preprocessing import StandardScaler

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
from .nowcast_truflation import (
    _safe_get_truflation,
    _truflation_series_to_pd,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

# Heavy-regularization grid for the residual Ridge. Residual signal is
# small + noisy + sample-poor, so alpha needs to be able to shrink the
# correction toward zero when regime indicators carry no information.
_RESID_RIDGE_ALPHAS = np.logspace(0, 4, 25)  # 1 ... 10000

# Hard cap on the absolute residual correction (MoM space). Even if Ridge
# is confident, never let it shift the base model by more than this.
_ACCEL_CLIP = 0.30

# Minimum number of (regime_feats, residual) pairs before we trust Ridge.
_MIN_RESID_ROWS = 18


@dataclass
class AccelNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_truflation_scrape: bool
    yellen_pred_mom: float       # base Yellen 1.1 (calibrated) prediction
    residual_correction: float   # ridge-predicted residual (MoM space)
    n_resid_rows: int


# ---------------------------------------------------------------------------
# Acceleration-feature engineering
# ---------------------------------------------------------------------------


_ACCEL_FEATURE_NAMES = (
    "accel_cpi_3m_minus_6m",   # CPI 3mo MoM avg minus 6mo MoM avg
    "accel_clev_slope_5d",     # Cleveland nowcast 5-day implied slope
    "accel_clev_slope_14d",    # Cleveland 14-day implied slope
    "accel_clev_slope_30d",    # Cleveland 30-day slope (clev[T] - clev[T-1])
    "accel_clev_slope_of_slope",  # 30d slope minus 60d slope (acceleration)
    "accel_truf_yoy_change_30d",  # Truflation YoY change last 30 days
    "accel_oil_14d_minus_60d", # Oil 14-day momentum minus 60-day
    "accel_yld_curve_change_30d",  # T10Y2Y change last 30 days
    "accel_clev_yoy_minus_lag",  # Cleveland YoY vs last released BLS YoY
)


def _safe_float(x) -> float:
    try:
        v = float(x)
        if np.isfinite(v):
            return v
        return float("nan")
    except Exception:
        return float("nan")


def _hist_yoy(clev: dict, key: str) -> float:
    """Cleveland headline YoY at historical[key] — np.nan if missing."""
    if not isinstance(clev, dict) or not clev.get("ok"):
        return float("nan")
    hist = clev.get("historical") or {}
    if not isinstance(hist, dict):
        return float("nan")
    entry = hist.get(key)
    if not isinstance(entry, dict):
        return float("nan")
    v = entry.get("yoy")
    if isinstance(v, (int, float)) and np.isfinite(v):
        return float(v)
    return float("nan")


def _value_on_or_before(s: pd.Series, anchor: pd.Timestamp) -> float:
    if s is None or s.empty:
        return float("nan")
    sub = s.loc[s.index <= anchor]
    if sub.empty:
        return float("nan")
    return float(sub.iloc[-1])


def _window_pct_change(s: pd.Series, end: pd.Timestamp, n: int) -> float:
    """Percent change between two consecutive n-day windows ending at end."""
    if s is None or s.empty:
        return float("nan")
    s_until = s.loc[s.index <= end]
    if s_until.empty:
        return float("nan")
    mid = end - pd.Timedelta(days=n)
    start = mid - pd.Timedelta(days=n)
    recent = s_until.loc[(s_until.index > mid) & (s_until.index <= end)]
    prior = s_until.loc[(s_until.index > start) & (s_until.index <= mid)]
    if len(recent) == 0 or len(prior) == 0:
        return float("nan")
    r = float(recent.mean())
    p = float(prior.mean())
    if not np.isfinite(r) or not np.isfinite(p) or p == 0:
        return float("nan")
    return (r / p - 1.0) * 100.0


def _accel_features_for_month(
    target_month_end: pd.Timestamp,
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    truf_yoy_series: pd.Series,
    as_of_day: int,
) -> dict[str, float]:
    """Build acceleration features for one target month.

    All features computed AS-OF day-`as_of_day` of the target month
    (point-in-time discipline matches the rest of the codebase).
    """
    feats: dict[str, float] = {k: float("nan") for k in _ACCEL_FEATURE_NAMES}

    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)

    # ---- CPI 3mo MoM avg minus 6mo MoM avg --------------------------------
    # Uses last released BLS CPI MoM history (index strictly < target_month_end).
    try:
        y_mom = build_target(panel).dropna()
        prior = y_mom.loc[y_mom.index < target_month_end]
        if len(prior) >= 6:
            avg_3m = float(prior.iloc[-3:].mean())
            avg_6m = float(prior.iloc[-6:].mean())
            feats["accel_cpi_3m_minus_6m"] = avg_3m - avg_6m
    except Exception:
        pass

    # ---- Cleveland nowcast slopes (5d / 14d / 30d / accel) ---------------
    # Use the historical archive at month T and prior months to derive
    # implied per-day slopes. Vintage discipline: clev[T] published at
    # ~day-20 of T, which is at-or-before our as_of.
    try:
        target_key = target_month_end.strftime("%Y-%m")
        prior_1_key = (m_start + pd.offsets.MonthBegin(-1)).strftime("%Y-%m")
        prior_2_key = (m_start + pd.offsets.MonthBegin(-2)).strftime("%Y-%m")

        yoy_t = _hist_yoy(clev, target_key)
        yoy_p1 = _hist_yoy(clev, prior_1_key)
        yoy_p2 = _hist_yoy(clev, prior_2_key)

        # Fall back to live currentMonth slot when archive lacks T (live cut).
        if not np.isfinite(yoy_t) and isinstance(clev, dict) and clev.get("ok"):
            for slot in ("currentMonth", "nextMonth"):
                head = (clev.get("headline", {}) or {}).get(slot) or {}
                if head.get("month") == target_key and isinstance(
                    head.get("yoy"), (int, float)
                ):
                    yoy_t = float(head["yoy"])
                    break

        if np.isfinite(yoy_t) and np.isfinite(yoy_p1):
            slope_30d = yoy_t - yoy_p1
            feats["accel_clev_slope_30d"] = slope_30d

            # Per-day slope expressed as monthly-rate equivalent (matches
            # the trajectory module convention).
            delta_30d = slope_30d
            yoy_5d = yoy_p1 + (25.0 / 30.0) * delta_30d
            yoy_14d = yoy_p1 + (16.0 / 30.0) * delta_30d
            feats["accel_clev_slope_5d"] = (yoy_t - yoy_5d) * (30.0 / 5.0)
            feats["accel_clev_slope_14d"] = (yoy_t - yoy_14d) * (30.0 / 14.0)

            if np.isfinite(yoy_p2):
                slope_60d = (yoy_t - yoy_p2) / 2.0
                feats["accel_clev_slope_of_slope"] = slope_30d - slope_60d

        # Cleveland YoY minus last released BLS YoY (regime-aware level diff).
        if np.isfinite(yoy_t):
            cpi = panel[TARGET.fred_id].dropna()
            last_released = (
                target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
            ) + pd.offsets.MonthEnd(0)
            cpi_prior = cpi.loc[cpi.index <= last_released]
            if len(cpi_prior) >= 13:
                lag_yoy = float(
                    (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0
                )
                feats["accel_clev_yoy_minus_lag"] = yoy_t - lag_yoy
    except Exception:
        pass

    # ---- Truflation YoY change in last 30 days --------------------------
    try:
        truf_now = _value_on_or_before(truf_yoy_series, as_of)
        truf_30d = _value_on_or_before(
            truf_yoy_series, as_of - pd.Timedelta(days=30)
        )
        if np.isfinite(truf_now) and np.isfinite(truf_30d):
            feats["accel_truf_yoy_change_30d"] = truf_now - truf_30d
    except Exception:
        pass

    # ---- Oil 14-day vs 60-day momentum -----------------------------------
    try:
        oil = daily_frame.get("DCOILWTICO")
        if oil is not None and not oil.empty:
            mom14 = _window_pct_change(oil, as_of, 14)
            mom60 = _window_pct_change(oil, as_of, 60)
            if np.isfinite(mom14) and np.isfinite(mom60):
                feats["accel_oil_14d_minus_60d"] = mom14 - mom60
    except Exception:
        pass

    # ---- Yield curve change in last 30 days (T10Y2Y) --------------------
    try:
        yc = daily_frame.get("T10Y2Y")
        if yc is not None and not yc.empty:
            now = _value_on_or_before(yc, as_of)
            then = _value_on_or_before(yc, as_of - pd.Timedelta(days=30))
            if np.isfinite(now) and np.isfinite(then):
                feats["accel_yld_curve_change_30d"] = now - then
    except Exception:
        pass

    return feats


def _accel_feature_row(feats: dict[str, float]) -> np.ndarray:
    """Extract the acceleration feature columns in canonical order."""
    return np.asarray(
        [_safe_float(feats.get(k, np.nan)) for k in _ACCEL_FEATURE_NAMES],
        dtype=float,
    )


# ---------------------------------------------------------------------------
# Yellen 1.1 in-sample prediction helper
# ---------------------------------------------------------------------------


def _yellen11_predict_in_sample(
    X: pd.DataFrame,
    y: pd.Series,
    models: dict,
    cols: list[str],
    panel: pd.DataFrame,
    y_mom_full: pd.Series,
    ridge_calib: Ridge | None,
) -> np.ndarray:
    """Compute Yellen 1.1's calibrated MoM prediction for each training row.

    Mirrors `_apply_calibration` but vectorized over X. Each row's
    prediction goes through the SAME pipeline the live model uses
    (median-quantile GBR → Ridge bias correction).
    """
    if len(X) == 0:
        return np.zeros((0,), dtype=float)

    Xv = X.values
    median_model = models[0.5]
    base_preds = median_model.predict(Xv)

    yoy_minus_lag = (
        X["clev_yoy_minus_lag"].values
        if "clev_yoy_minus_lag" in X.columns
        else np.zeros(len(X))
    )

    preds_calib = np.zeros(len(X), dtype=float)
    for i, idx in enumerate(X.index):
        try:
            pred_i = float(base_preds[i])
            vol_i = _recent_vol(y_mom_full, idx)
            yml_i = float(yoy_minus_lag[i]) if np.isfinite(yoy_minus_lag[i]) else 0.0
            mid_cal, _, _, _ = _apply_calibration(
                ridge_calib, pred_i, pred_i, pred_i, vol_i, yml_i,
            )
            preds_calib[i] = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))
        except Exception:
            preds_calib[i] = float(np.clip(float(base_preds[i]), _MOM_LO_CLIP, _MOM_HI_CLIP))
    return preds_calib


# ---------------------------------------------------------------------------
# Residual (acceleration-driven) Ridge fit
# ---------------------------------------------------------------------------


def _build_residual_dataset(
    X_index: pd.DatetimeIndex,
    yellen_preds: np.ndarray,
    y_actuals: np.ndarray,
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    truf_yoy_series: pd.Series,
    as_of_day: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Build (regime_feats, residuals) pairs for Ridge training."""
    feats_list: list[np.ndarray] = []
    targets: list[float] = []

    for idx, yhat, ytrue in zip(X_index, yellen_preds, y_actuals):
        try:
            af = _accel_features_for_month(
                idx, panel, daily_frame, clev, truf_yoy_series, as_of_day,
            )
            row = _accel_feature_row(af)
            feats_list.append(row)
            targets.append(float(ytrue) - float(yhat))
        except Exception:
            continue

    if not feats_list:
        return np.zeros((0, len(_ACCEL_FEATURE_NAMES))), np.zeros((0,))

    F = np.asarray(feats_list, dtype=float)
    t = np.asarray(targets, dtype=float)
    return F, t


def _fit_residual_ridge(
    F: np.ndarray, t: np.ndarray,
) -> tuple[StandardScaler | None, RidgeCV | None, np.ndarray]:
    """Fit a strongly-regularized RidgeCV on (regime feats → residual).

    Returns (scaler, ridge, col_medians_for_imputation). Returns Nones if
    too few rows. The training-set column medians are kept so we can impute
    missing inference features the same way training was imputed.
    """
    if len(F) < _MIN_RESID_ROWS:
        return None, None, np.zeros(F.shape[1] if F.ndim == 2 else 0)

    try:
        col_medians = np.nanmedian(F, axis=0)
        col_medians = np.where(np.isfinite(col_medians), col_medians, 0.0)
        Fi = np.where(np.isfinite(F), F, col_medians[None, :])

        scaler = StandardScaler().fit(Fi)
        Fs = scaler.transform(Fi)
        ridge = RidgeCV(alphas=_RESID_RIDGE_ALPHAS, fit_intercept=True).fit(Fs, t)
        return scaler, ridge, col_medians
    except Exception:
        return None, None, np.zeros(F.shape[1] if F.ndim == 2 else 0)


def _apply_residual_correction(
    scaler: StandardScaler | None,
    ridge: RidgeCV | None,
    accel_row: np.ndarray,
    col_medians: np.ndarray,
) -> float:
    """Predict the residual correction. Clipped to ±_ACCEL_CLIP."""
    if ridge is None or scaler is None:
        return 0.0
    try:
        if accel_row.ndim == 1:
            accel_row = accel_row[None, :]
        # Impute missing values with training column medians.
        imputed = np.where(
            np.isfinite(accel_row), accel_row, col_medians[None, :],
        )
        Fs = scaler.transform(imputed)
        delta = float(ridge.predict(Fs)[0])
        return float(np.clip(delta, -_ACCEL_CLIP, _ACCEL_CLIP))
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_accel_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of Yellen 1.1 + acceleration-residual Ridge."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok") and clev.get("historical"))

    truf = _safe_get_truflation()
    truf_yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    used_truf = bool(truf.get("ok") and not truf_yoy_series.empty)

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

            # --- Stage 0: Yellen 1.0 base feature set + GBR triple --------
            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # --- Stage 1: Yellen 1.1 calibrator (Ridge bias correction) --
            train_y_mom = build_target(train_panel).dropna()
            F_cal, t_cal = _build_calibration_dataset(
                X, y, models, cols, train_panel, train_y_mom,
            )
            ridge_calib = _fit_calibrator(F_cal, t_cal)

            # --- Stage 2: residual learning with acceleration features ---
            yellen_in_sample = _yellen11_predict_in_sample(
                X, y, models, cols, train_panel, train_y_mom, ridge_calib,
            )
            F_res, t_res = _build_residual_dataset(
                X.index, yellen_in_sample, y.values,
                train_panel, daily_frame, clev, truf_yoy_series, as_of_day,
            )
            scaler_res, ridge_res, col_medians = _fit_residual_ridge(F_res, t_res)

            # --- Inference: same Yellen 1.1 path, then residual add ------
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
            mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
            mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

            inf_vol = _recent_vol(train_y_mom, target_month_end)
            inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
            if not np.isfinite(inf_yml):
                inf_yml = 0.0
            mid_yellen, lo_yellen, hi_yellen, _ = _apply_calibration(
                ridge_calib, mid_base, lo_base, hi_base, inf_vol, inf_yml,
            )
            mid_yellen = float(np.clip(mid_yellen, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Acceleration features at inference time, then residual delta.
            accel_inf = _accel_features_for_month(
                target_month_end, train_panel, daily_frame, clev,
                truf_yoy_series, as_of_day,
            )
            accel_row = _accel_feature_row(accel_inf)
            delta = _apply_residual_correction(
                scaler_res, ridge_res, accel_row, col_medians,
            )

            mid_final = float(
                np.clip(mid_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP)
            )
            lo_final = float(
                np.clip(lo_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP)
            )
            hi_final = float(
                np.clip(hi_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP)
            )

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
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
                "yellen_pred_mom": round(mid_yellen, 4),
                "resid_correction": round(delta, 4),
                "pred_mom": round(mid_final, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_resid_rows": int(len(F_res)),
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
        "usedClevScrape": used_clev,
        "usedTruflationScrape": used_truf,
        "rows": rows,
    }


def run_accel_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> AccelNowcastResult:
    """Live nowcast: Yellen 1.1 + acceleration-residual Ridge correction."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok"))

    truf = _safe_get_truflation()
    truf_yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    used_truf = bool(truf.get("ok") and not truf_yoy_series.empty)

    # --- Yellen 1.0 base + GBR triple ---------------------------------
    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    # --- Yellen 1.1 calibrator -----------------------------------------
    y_mom = build_target(panel).dropna()
    F_cal, t_cal = _build_calibration_dataset(X, y, models, cols, panel, y_mom)
    ridge_calib = _fit_calibrator(F_cal, t_cal)

    # --- Stage 2 residual model (acceleration features) ---------------
    yellen_in_sample = _yellen11_predict_in_sample(
        X, y, models, cols, panel, y_mom, ridge_calib,
    )
    F_res, t_res = _build_residual_dataset(
        X.index, yellen_in_sample, y.values,
        panel, daily_frame, clev, truf_yoy_series, as_of_day,
    )
    scaler_res, ridge_res, col_medians = _fit_residual_ridge(F_res, t_res)

    # --- Inference timing ---------------------------------------------
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
    mid_yellen, lo_yellen, hi_yellen, _ = _apply_calibration(
        ridge_calib, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_yellen = float(np.clip(mid_yellen, _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Inference-time acceleration features and residual correction.
    accel_inf = _accel_features_for_month(
        target_month_end, panel, daily_frame, clev, truf_yoy_series, as_of_day,
    )
    accel_row = _accel_feature_row(accel_inf)
    delta = _apply_residual_correction(
        scaler_res, ridge_res, accel_row, col_medians,
    )

    mid_final = float(np.clip(mid_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP))
    lo_final = float(np.clip(lo_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP))
    hi_final = float(np.clip(hi_yellen + delta, _MOM_LO_CLIP, _MOM_HI_CLIP))

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
    return AccelNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_final,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_clev,
        used_truflation_scrape=used_truf,
        yellen_pred_mom=mid_yellen,
        residual_correction=delta,
        n_resid_rows=int(len(F_res)),
    )
