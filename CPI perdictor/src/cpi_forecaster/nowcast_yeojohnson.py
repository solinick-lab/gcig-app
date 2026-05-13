"""Yeo-Johnson power-transformed feature nowcaster.

Hypothesis: Yellen 1.1's feature set (rich daily features + Cleveland Fed
nowcast features + lag/seasonal terms) contains many heavy-tailed and
skewed columns (e.g. commodity returns, oil futures changes, breakevens
near tail moves, FX vol). GBR splits on these features can be
"wasted" on shaping the bulk of the distribution rather than the
informative shoulders, since the loss is dominated by extreme values
that one-shot the trees.

Yeo-Johnson is the Box-Cox extension that supports negative values too —
so it can normalise both signed return-style features and positive-only
levels. After Yeo-Johnson, each feature is more symmetric / closer to
Gaussian, which lets the GBR pick splits at more informative quantiles
of the feature distribution.

Pipeline:
  1. Build Yellen 1.1's supervised dataset (rich + Cleveland features).
  2. Fit `PowerTransformer(method='yeo-johnson', standardize=True)` on
     X_train. The transformer learns lambda per feature.
  3. Transform X_train, fit q={0.1, 0.5, 0.9} GBR on transformed X.
  4. At inference, apply the same fitted transformer to x_inf, predict.
  5. Same MoM-clip + MoM->YoY conversion + 80% bands as the base.

Public API (matches Yellen 1.1 standard interface):
  backtest_yeojohnson_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_yeojohnson_nowcast(as_of_day=20) -> YeoJohnsonNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.preprocessing import PowerTransformer

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
    _GBR_PARAMS,
)


warnings.filterwarnings("ignore")


@dataclass
class YeoJohnsonNowcastResult:
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
# Power transform helpers
# ---------------------------------------------------------------------------


def _fit_power_transformer(X: pd.DataFrame) -> PowerTransformer | None:
    """Fit a Yeo-Johnson PowerTransformer on the training feature matrix.

    `standardize=True` means after Yeo-Johnson the output is also z-scored
    per column. This is what we want for GBR: tree splits are
    scale-invariant in theory but the marginal distribution shape *does*
    matter for which thresholds the greedy split picker tries (sklearn
    histograms quantile-bin internally), so a more uniform/Gaussian
    feature gives better split candidates.

    Returns None if fitting fails (e.g. constant columns), in which case
    the caller falls back to raw features.
    """
    try:
        if X.empty or X.shape[1] == 0:
            return None
        # Yeo-Johnson requires finite input. Fill any residual NaNs with
        # column medians (the supervised builder already did this, but be
        # defensive).
        Xv = X.values.astype(float)
        if not np.all(np.isfinite(Xv)):
            return None
        pt = PowerTransformer(method="yeo-johnson", standardize=True)
        pt.fit(Xv)
        return pt
    except Exception:
        return None


def _transform_X(pt: PowerTransformer | None, X: pd.DataFrame) -> np.ndarray:
    """Apply the fitted transform; on failure return raw values."""
    Xv = X.values.astype(float)
    if pt is None:
        return Xv
    try:
        Xt = pt.transform(Xv)
        # Replace any non-finite outputs (rare, but possible if a column
        # had near-zero variance and the inverse transform blows up).
        if not np.all(np.isfinite(Xt)):
            Xt = np.where(np.isfinite(Xt), Xt, 0.0)
        return Xt
    except Exception:
        return Xv


def _transform_x_inf(
    pt: PowerTransformer | None,
    x_inf: pd.Series,
    cols: list[str],
    X_train: pd.DataFrame,
) -> np.ndarray:
    """Reindex inference features to training columns, apply transform."""
    aligned = (
        x_inf.reindex(cols)
        .fillna(X_train.median(numeric_only=True))
        .fillna(0.0)
    )
    arr = aligned.values.astype(float).reshape(1, -1)
    if pt is None:
        return arr
    try:
        out = pt.transform(arr)
        if not np.all(np.isfinite(out)):
            out = np.where(np.isfinite(out), out, 0.0)
        return out
    except Exception:
        return arr


# ---------------------------------------------------------------------------
# Fit / predict
# ---------------------------------------------------------------------------


def _fit_quantile_models_yj(Xt: np.ndarray, y: pd.Series) -> dict:
    """Fit q={0.1, 0.5, 0.9} GBR on the YJ-transformed feature matrix."""
    models: dict = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xt, y.values)
    return models


def _predict_triple_yj(models: dict, x_inf_t: np.ndarray) -> tuple[float, float, float]:
    preds = sorted(float(models[q].predict(x_inf_t)[0]) for q in _QUANTILES)
    lo, mid, hi = preds
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_yeojohnson_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the Yeo-Johnson power-transformed nowcaster."""
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

            cols = list(X.columns)
            pt = _fit_power_transformer(X)
            Xt = _transform_X(pt, X)
            models = _fit_quantile_models_yj(Xt, y)

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
            x_inf_t = _transform_x_inf(pt, x_inf, cols, X)

            mid, lo, hi = _predict_triple_yj(models, x_inf_t)
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
                "n_features": len(cols),
                "used_yj": pt is not None,
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


def run_yeojohnson_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> YeoJohnsonNowcastResult:
    """Live nowcast using Yeo-Johnson-transformed Yellen 1.1 features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    cols = list(X.columns)
    pt = _fit_power_transformer(X)
    Xt = _transform_X(pt, X)
    models = _fit_quantile_models_yj(Xt, y)

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

    x_inf = pd.Series(feats)
    x_inf_t = _transform_x_inf(pt, x_inf, cols, X)
    mid, lo, hi = _predict_triple_yj(models, x_inf_t)
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
    return YeoJohnsonNowcastResult(
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
