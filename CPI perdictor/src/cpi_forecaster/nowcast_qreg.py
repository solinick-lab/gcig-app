"""Linear quantile-regression nowcaster (no boosting).

Hypothesis: the Yellen 1.1 feature set (Cleveland-augmented quantile_rich)
already carries the bulk of the predictive signal. Boosted ensembles
(GBR, ExtraTrees, HistGBM) can overfit the small monthly panel and
import structural quirks (axis-aligned splits, threshold artifacts) that
generalize poorly under regime change. A *linear* quantile regressor is:

  - more interpretable (each feature has a single signed coefficient);
  - more robust to feature-scale collinearity once L1-regularised;
  - free of split-induced step jumps that hurt MAE on smooth targets.

Approach:
  - Reuse the exact Yellen 1.1 supervised matrix from
    ``_build_supervised_clev`` (panel, daily_frame, Cleveland scrape,
    as_of_day).
  - Standardise features (zero-mean, unit-variance) then fit
    ``sklearn.linear_model.QuantileRegressor(quantile=0.5, alpha=0.5)``
    for the median; fit q=0.1 / q=0.9 for the 80% bands.
  - Inference mirrors ``clev_calibrated`` exactly (same feature
    construction, same MoM->YoY conversion, same clipping floors).

Public API:
  backtest_qreg_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_qreg_nowcast(as_of_day=20) -> QregNowcastResult

Same return-dict keys as nowcast.backtest_nowcast: rmseMom, rmseYoy,
maeYoy, hitWithin25bp, hitWithin50bp, totalCuts, asOfDay, windowMonths,
rows. Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import QuantileRegressor
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

_QREG_ALPHA = 0.5            # L1 regularisation strength on the linear weights
_QREG_QUANTILE_MID = 0.5     # median for point estimate
_QREG_QUANTILE_LO = 0.1      # 10th percentile -> lower 80% band
_QREG_QUANTILE_HI = 0.9      # 90th percentile -> upper 80% band
_QREG_SOLVER = "highs"       # fast, robust LP solver bundled with scipy


@dataclass
class QregNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_features: int


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_qreg_triple(
    X: pd.DataFrame, y: pd.Series,
) -> tuple[StandardScaler, QuantileRegressor, QuantileRegressor, QuantileRegressor]:
    """Standardise then fit three QuantileRegressor heads (lo / mid / hi).

    Returns ``(scaler, qr_lo, qr_mid, qr_hi)``. Falls back to the median
    head as the lo/hi if a band fit fails so callers always get usable
    predictions.
    """
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X.values)
    yv = y.values

    qr_mid = QuantileRegressor(
        quantile=_QREG_QUANTILE_MID,
        alpha=_QREG_ALPHA,
        solver=_QREG_SOLVER,
    )
    qr_mid.fit(Xs, yv)

    try:
        qr_lo = QuantileRegressor(
            quantile=_QREG_QUANTILE_LO,
            alpha=_QREG_ALPHA,
            solver=_QREG_SOLVER,
        )
        qr_lo.fit(Xs, yv)
    except Exception:
        qr_lo = qr_mid

    try:
        qr_hi = QuantileRegressor(
            quantile=_QREG_QUANTILE_HI,
            alpha=_QREG_ALPHA,
            solver=_QREG_SOLVER,
        )
        qr_hi.fit(Xs, yv)
    except Exception:
        qr_hi = qr_mid

    return scaler, qr_lo, qr_mid, qr_hi


def _predict_triple(
    scaler: StandardScaler,
    qr_lo: QuantileRegressor,
    qr_mid: QuantileRegressor,
    qr_hi: QuantileRegressor,
    x_inf: np.ndarray,
) -> tuple[float, float, float]:
    """Apply the saved scaler then return (mid, lo, hi)."""
    xs = scaler.transform(x_inf)
    mid = float(qr_mid.predict(xs)[0])
    lo = float(qr_lo.predict(xs)[0])
    hi = float(qr_hi.predict(xs)[0])
    if lo > hi:
        lo, hi = hi, lo
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_qreg_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Yellen 1.1 features + linear QuantileRegressor."""
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

            scaler, qr_lo, qr_mid, qr_hi = _fit_qreg_triple(X, y)
            cols = list(X.columns)

            # Inference features (same recipe as Yellen 1.1)
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
            x_inf_arr = x_inf.values.reshape(1, -1)

            mid, lo, hi = _predict_triple(scaler, qr_lo, qr_mid, qr_hi, x_inf_arr)
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
                "qreg_lo10": round(lo, 4),
                "qreg_hi90": round(hi, 4),
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


def run_qreg_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> QregNowcastResult:
    """Live nowcast using Yellen 1.1 features + linear QuantileRegressor."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    scaler, qr_lo, qr_mid, qr_hi = _fit_qreg_triple(X, y)
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
    x_inf_arr = x_inf.values.reshape(1, -1)

    mid, lo, hi = _predict_triple(scaler, qr_lo, qr_mid, qr_hi, x_inf_arr)
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
    return QregNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_features=len(cols),
    )
