"""ExtraTrees-based nowcaster with tree-level quantile aggregation.

Hypothesis: the Yellen 1.1 feature set (Cleveland-augmented quantile_rich)
already carries the bulk of the predictive signal. The bottleneck is the
single-model variance of any one quantile-GBR triple. Replace the GBR
quantile heads with a 500-tree ExtraTreesRegressor and recover the
distribution from the tree-level predictions:

  - point estimate = median of the 500 tree predictions
  - 80% band       = 10th / 90th percentile of the 500 tree predictions

ExtraTrees tends to be lower-bias than RandomForest at modest sample sizes
because every tree splits at the same root threshold (random thresholds
chosen at every node) so each tree is more decorrelated. With 500 trees
the prediction variance is small, but the spread across the 500 trees
themselves carries calibration information about predictive uncertainty.

Public API:
  backtest_extratrees_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_extratrees_nowcast(as_of_day=20) -> ExtraTreesNowcastResult

Same return-dict keys as nowcast.backtest_nowcast: rmseMom, rmseYoy,
maeYoy, hitWithin25bp, hitWithin50bp, totalCuts, asOfDay, windowMonths,
rows. Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor

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

_N_ESTIMATORS = 500
_LO_PCT = 10.0
_HI_PCT = 90.0
_RANDOM_STATE = 42

_ET_PARAMS = dict(
    n_estimators=_N_ESTIMATORS,
    random_state=_RANDOM_STATE,
    n_jobs=-1,
    bootstrap=False,  # ExtraTrees default — every tree sees full sample
)


@dataclass
class ExtraTreesNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_estimators: int


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_extratrees(X: pd.DataFrame, y: pd.Series) -> ExtraTreesRegressor:
    """Fit a single ExtraTrees with 500 trees on the full training matrix."""
    et = ExtraTreesRegressor(**_ET_PARAMS)
    et.fit(X.values, y.values)
    return et


def _tree_level_predictions(
    et: ExtraTreesRegressor,
    x_inf: np.ndarray,
) -> np.ndarray:
    """Return the array of per-tree predictions for a single inference row.

    Shape: (n_estimators,). Calls each fitted DecisionTreeRegressor in
    `et.estimators_` and stacks the scalar predictions.
    """
    preds = np.empty(len(et.estimators_), dtype=float)
    for i, tree in enumerate(et.estimators_):
        preds[i] = float(tree.predict(x_inf)[0])
    return preds


def _aggregate_quantile(preds: np.ndarray) -> tuple[float, float, float]:
    """Median for point, 10th/90th percentile for bands."""
    mid = float(np.median(preds))
    lo = float(np.percentile(preds, _LO_PCT))
    hi = float(np.percentile(preds, _HI_PCT))
    if lo > hi:
        lo, hi = hi, lo
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_extratrees_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Yellen 1.1 features + ExtraTrees(500)."""
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

            et = _fit_extratrees(X, y)
            cols = list(X.columns)

            # Inference features (same as clev_nowcast)
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

            tree_preds = _tree_level_predictions(et, x_inf_arr)
            mid, lo, hi = _aggregate_quantile(tree_preds)
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
                "tree_lo10": round(lo, 4),
                "tree_hi90": round(hi, 4),
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


def run_extratrees_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ExtraTreesNowcastResult:
    """Live nowcast using Yellen 1.1 features + ExtraTrees(500)."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    et = _fit_extratrees(X, y)
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

    tree_preds = _tree_level_predictions(et, x_inf_arr)
    mid, lo, hi = _aggregate_quantile(tree_preds)
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
    return ExtraTreesNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_estimators=_N_ESTIMATORS,
    )
