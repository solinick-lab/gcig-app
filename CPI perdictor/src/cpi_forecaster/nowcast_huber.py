"""Huber-regression nowcaster (M-estimator robust to outliers).

Hypothesis: Yellen 1.1's GBR quantile triple is sensitive to a few extreme
months (COVID prints, energy spikes) that drag the in-sample fit. A Huber
M-estimator (`sklearn.linear_model.HuberRegressor`, epsilon=1.35) trained
on the same Yellen 1.1 (Cleveland-augmented) feature matrix downweights
residuals beyond ~1.35*sigma, so the linear fit reflects the bulk of the
distribution rather than the tails.

Approach:
  1. Reuse Yellen 1.1's feature matrix via _build_supervised_clev (same
     Cleveland scrape integration, lagged CPI, daily-derived features).
  2. Fit a single HuberRegressor (epsilon=1.35, fit_intercept=True) with
     a StandardScaler upstream — Huber's IRLS is scale-sensitive and the
     feature columns mix percentages, levels, and z-scored composites.
  3. Point prediction = HuberRegressor.predict(x_inf).
  4. 80% bands: training-residual std (excluding the >epsilon-weighted
     outliers) times z=1.2816 (the one-sided 90th-percentile of the
     standard normal — symmetric +/- gives an 80% interval).

Public API:
  backtest_huber_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_huber_nowcast(as_of_day=20) -> HuberNowcastResult

Same return-dict keys as nowcast.backtest_nowcast: rmseMom, rmseYoy,
maeYoy, hitWithin25bp, hitWithin50bp, totalCuts, asOfDay, windowMonths,
rows. Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import HuberRegressor
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
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_HUBER_EPSILON = 1.35      # standard Huber threshold (≈95% efficiency under N(0,1))
_HUBER_ALPHA = 1e-4        # tiny L2 — keep coefficients finite when features collinear
_HUBER_MAX_ITER = 200
_BAND_Z = 1.2816           # one-sided z for 80% interval (Φ⁻¹(0.90))


@dataclass
class HuberNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    resid_sigma_mom: float
    n_outliers: int


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_huber(X: pd.DataFrame, y: pd.Series) -> tuple[StandardScaler, HuberRegressor]:
    """Standardize features then fit HuberRegressor(epsilon=1.35).

    HuberRegressor is scale-sensitive — IRLS reweights observations by
    residual size, so disparate column scales (percentages vs. levels)
    distort the loss. StandardScaler with mean=0, std=1 makes epsilon
    operate uniformly across features.
    """
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X.values)
    huber = HuberRegressor(
        epsilon=_HUBER_EPSILON,
        alpha=_HUBER_ALPHA,
        max_iter=_HUBER_MAX_ITER,
        fit_intercept=True,
    )
    huber.fit(Xs, y.values)
    return scaler, huber


def _residual_band_sigma(
    huber: HuberRegressor,
    Xs: np.ndarray,
    y: np.ndarray,
) -> tuple[float, int]:
    """Std of in-sample residuals excluding Huber-flagged outliers.

    HuberRegressor exposes `outliers_` — a boolean mask of training rows
    whose residual exceeded epsilon*scale. We use only the inlier
    residuals to estimate the conditional spread, which keeps the bands
    from being inflated by the very tails the M-estimator just dropped.
    """
    preds = huber.predict(Xs)
    resid = y - preds
    try:
        outlier_mask = np.asarray(huber.outliers_, dtype=bool)
        if outlier_mask.shape[0] != resid.shape[0]:
            outlier_mask = np.zeros_like(resid, dtype=bool)
    except Exception:
        outlier_mask = np.zeros_like(resid, dtype=bool)

    inlier_resid = resid[~outlier_mask]
    if len(inlier_resid) < 4:
        inlier_resid = resid  # fall back to full residual set
    sigma = float(np.std(inlier_resid, ddof=1)) if len(inlier_resid) > 1 else 0.0
    if not np.isfinite(sigma):
        sigma = 0.0
    return sigma, int(outlier_mask.sum())


def _predict_huber(
    scaler: StandardScaler,
    huber: HuberRegressor,
    x_inf: pd.Series,
) -> float:
    Xs = scaler.transform(x_inf.values.reshape(1, -1))
    return float(huber.predict(Xs)[0])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_huber_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Yellen 1.1 features + HuberRegressor."""
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

            scaler, huber = _fit_huber(X, y)
            cols = list(X.columns)

            sigma, n_out = _residual_band_sigma(
                huber, scaler.transform(X.values), y.values
            )

            # Inference features (same recipe as Yellen 1.1).
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

            mid = _predict_huber(scaler, huber, x_inf)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            band = _BAND_Z * sigma
            lo = mid - band
            hi = mid + band

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
                "lo_mom": round(lo, 4),
                "hi_mom": round(hi, 4),
                "resid_sigma": round(sigma, 4),
                "n_outliers": n_out,
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


def run_huber_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> HuberNowcastResult:
    """Live nowcast using Yellen 1.1 features + HuberRegressor(epsilon=1.35)."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    scaler, huber = _fit_huber(X, y)
    cols = list(X.columns)
    sigma, n_out = _residual_band_sigma(
        huber, scaler.transform(X.values), y.values
    )

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
    mid = _predict_huber(scaler, huber, x_inf)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
    band = _BAND_Z * sigma
    lo = mid - band
    hi = mid + band

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
    return HuberNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        resid_sigma_mom=sigma,
        n_outliers=n_out,
    )
