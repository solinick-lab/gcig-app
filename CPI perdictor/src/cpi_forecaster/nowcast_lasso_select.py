"""Lasso-feature-selected nowcaster.

Hypothesis: Yellen 1.1 (clev_calibrated) trains q={0.1,0.5,0.9} GBR on the
FULL feature set from `_build_supervised_clev` (rich daily features + CPI
lags + seasonal + Cleveland-derived features). With ~30+ features and a
modest number of training rows (~100s), the GBR may be over-fitting noisy
features that hurt out-of-sample RMSE. A sparser feature set trained via
Lasso may generalize better.

Approach:
  1. Build the SAME supervised dataset as Yellen 1.0/1.1
     (`_build_supervised_clev`).
  2. Standardize features (per-column mean/std on the training fold) so
     L1 penalty applies on equal footing.
  3. Fit `LassoCV` (with TimeSeriesSplit cv) on the standardized full
     feature set to select features with non-zero coefficients.
  4. Take the SURVIVOR subset (always include the Cleveland nowcast
     features `clev_yoy`, `clev_mom`, `clev_yoy_minus_lag` if present —
     they are the strongest signal and we don't want Lasso to drop them
     on a small fold).
  5. Train q={0.1, 0.5, 0.9} GBR on the SURVIVOR subset (raw, unscaled
     since GBR is scale-invariant).
  6. Predict + clip per the standard pipeline.

Public API:
  backtest_lasso_select_nowcast(panel, daily_frame, window_months=24,
                                as_of_day=20) -> dict
  run_lasso_select_nowcast(as_of_day=20) -> LassoSelectNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5]. Falls back
gracefully to the full feature set if Lasso selects nothing.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import LassoCV
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import TimeSeriesSplit

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

# Lasso config — TimeSeriesSplit ensures we don't peek into the future
# when picking the alpha (regularization strength).
_LASSO_CV_SPLITS = 5
_LASSO_MAX_ITER = 5000
_LASSO_RANDOM_STATE = 42

# Minimum number of survivor features. If Lasso shrinks too aggressively
# we fall back to the full feature set.
_MIN_SURVIVORS = 4

# Always keep these key Cleveland-related features (if present in the
# training matrix) regardless of Lasso shrinkage — they are the
# externally-anchored signal that gives Yellen its edge.
_PROTECTED_FEATURES: tuple[str, ...] = (
    "clev_yoy",
    "clev_mom",
    "clev_yoy_minus_lag",
    "cpi_mom_lag1",
    "cpi_yoy_lag1",
)


@dataclass
class LassoSelectNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_features_total: int
    n_features_selected: int
    selected_features: list[str]


# ---------------------------------------------------------------------------
# Lasso feature selection
# ---------------------------------------------------------------------------


def _select_features_lasso(X: pd.DataFrame, y: pd.Series) -> list[str]:
    """Return the list of feature columns with non-zero Lasso coefficients.

    Uses StandardScaler + LassoCV (TimeSeriesSplit) so the L1 penalty is
    fair across columns of different scales. Always includes the
    `_PROTECTED_FEATURES` set if those columns exist in X — they are
    pre-validated signal anchors. If Lasso prunes too aggressively we
    fall back to all columns.
    """
    cols = list(X.columns)
    if len(X) < 24 or len(cols) == 0:
        return cols

    try:
        Xv = X.values.astype(float)
        yv = y.values.astype(float)
        # Replace any residual NaNs / infs (defensive — _build_supervised_clev
        # already fills medians, but be safe).
        Xv = np.nan_to_num(Xv, nan=0.0, posinf=0.0, neginf=0.0)
        yv = np.nan_to_num(yv, nan=0.0, posinf=0.0, neginf=0.0)

        scaler = StandardScaler()
        Xs = scaler.fit_transform(Xv)

        n_splits = min(_LASSO_CV_SPLITS, max(2, len(X) // 12))
        tscv = TimeSeriesSplit(n_splits=n_splits)

        lasso = LassoCV(
            cv=tscv,
            max_iter=_LASSO_MAX_ITER,
            random_state=_LASSO_RANDOM_STATE,
            n_jobs=None,
        )
        lasso.fit(Xs, yv)
        coefs = np.asarray(lasso.coef_, dtype=float)
    except Exception:
        return cols

    # Survivors = non-zero |coef|
    nonzero_mask = np.abs(coefs) > 1e-12
    survivors = [c for c, keep in zip(cols, nonzero_mask) if keep]

    # Add protected features (if they exist in X) without duplicates,
    # preserving the original column ordering.
    survivor_set = set(survivors)
    for prot in _PROTECTED_FEATURES:
        if prot in X.columns:
            survivor_set.add(prot)

    final = [c for c in cols if c in survivor_set]

    # Fallback: if too sparse, keep everything (Lasso may have over-shrunk
    # on a small fold).
    if len(final) < _MIN_SURVIVORS:
        return cols
    return final


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_lasso_select_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Lasso-selected features + GBR quantile stack."""
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

            X_full, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X_full) < 24:
                continue

            # --- Lasso feature selection on standardized full feature set ---
            selected = _select_features_lasso(X_full, y)
            X = X_full[selected]
            cols = list(X.columns)

            # --- Fit q={0.1, 0.5, 0.9} GBR on survivor subset ---
            models = _fit_quantile_models(X, y)

            # --- Inference features (same as clev_nowcast) ---
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

            mid, lo, hi = _predict_triple(models, x_inf, cols)
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
                "n_features_total": int(X_full.shape[1]),
                "n_features_selected": int(X.shape[1]),
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


def run_lasso_select_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> LassoSelectNowcastResult:
    """Live nowcast using Lasso-selected features + GBR quantile stack."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X_full, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    selected = _select_features_lasso(X_full, y)
    X = X_full[selected]
    cols = list(X.columns)

    models = _fit_quantile_models(X, y)

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
    mid, lo, hi = _predict_triple(models, x_inf, cols)
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
    return LassoSelectNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_features_total=int(X_full.shape[1]),
        n_features_selected=int(X.shape[1]),
        selected_features=cols,
    )
