"""Bootstrap-aggregated (bagged) version of `nowcast_clev`.

The single quantile-rich + Cleveland-feature stack in `nowcast_clev.py`
produces a strong baseline (~0.12 RMSE YoY), but its forecast on each cut
still depends sensitively on which 60-or-so months happen to land in the
training window — a few unlucky cuts inflate the YoY RMSE.

Bagging is the textbook fix: train many GBR triples on bootstrap subsamples
of the supervised rows and aggregate. Variance of the aggregate falls
roughly as 1/N_bags, while the bias of clev_nowcast (driven by the strong
Cleveland features) is preserved.

Strategy:
  - Build the supervised matrix exactly the way `nowcast_clev` does (we
    re-use its `_build_supervised_clev` helper directly so feature
    engineering stays identical to the baseline).
  - For each of N_BAGS=30 bags:
      * draw a bootstrap subsample of 85% of rows (with replacement)
      * fit q={0.1, 0.5, 0.9} GradientBoostingRegressor on that bag
  - Aggregate at inference time:
      mean prediction = median across the 30 bag-q0.5 predictions
      lo80            = 10th percentile across the 30 bag-q0.1 predictions
      hi80            = 90th percentile across the 30 bag-q0.9 predictions

We keep `_GBR_PARAMS` modestly smaller than the baseline's 400-tree fit so
that 30 bags x 3 quantiles fit comfortably under 90s/cut. Using
`n_estimators=200` keeps each individual learner expressive while the
bag-aggregate eats the variance.

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].

Public API:
  backtest_clev_bagged_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_clev_bagged_nowcast(as_of_day=20) -> ClevBaggedNowcastResult
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
from .nowcast_clev import (
    _build_supervised_clev,
    _clev_features_for_month,
    _mom_to_yoy,
    _safe_get_clev,
)
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_N_BAGS = 30
_BAG_FRAC = 0.85
_RANDOM_STATE = 42

# Slimmer than the baseline (400) so 30 bags x 3 quantiles fit in budget.
_GBR_PARAMS = dict(
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
)


@dataclass
class ClevBaggedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_bags: int


# ---------------------------------------------------------------------------
# Bag fitting
# ---------------------------------------------------------------------------


def _fit_bag_quantile_models(
    Xv: np.ndarray, yv: np.ndarray, seed: int,
) -> dict[float, GradientBoostingRegressor]:
    """Fit q={0.1, 0.5, 0.9} GBR on one bag's data."""
    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, random_state=seed, **_GBR_PARAMS,
        ).fit(Xv, yv)
    return models


def _fit_bagged_models(
    X: pd.DataFrame, y: pd.Series,
) -> tuple[list[dict[float, GradientBoostingRegressor]], list[str]]:
    """Fit N_BAGS triples on bootstrap subsamples of 85% of the rows."""
    cols = list(X.columns)
    Xv = X.values.astype(float)
    yv = y.values.astype(float)
    n = len(yv)
    bag_size = max(1, int(np.floor(_BAG_FRAC * n)))

    rng = np.random.default_rng(_RANDOM_STATE)
    bags: list[dict[float, GradientBoostingRegressor]] = []
    for _ in range(_N_BAGS):
        try:
            idx = rng.choice(n, size=bag_size, replace=True)
            Xb = Xv[idx]
            yb = yv[idx]
            seed = int(rng.integers(0, 2**31 - 1))
            bags.append(_fit_bag_quantile_models(Xb, yb, seed))
        except Exception:
            # One bad bag shouldn't kill aggregation; skip and continue.
            continue

    if len(bags) < 5:
        raise RuntimeError("too few bags fit successfully")
    return bags, cols


def _aggregate_bag_predictions(
    bags: list[dict[float, GradientBoostingRegressor]],
    x_inf: pd.Series,
    cols: list[str],
) -> tuple[float, float, float]:
    """Aggregate (mid, lo, hi) across bags.

    mid = median of the per-bag q=0.5 predictions
    lo  = 10th percentile of the per-bag q=0.1 predictions
    hi  = 90th percentile of the per-bag q=0.9 predictions
    """
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)

    q10_preds: list[float] = []
    q50_preds: list[float] = []
    q90_preds: list[float] = []
    for bag in bags:
        try:
            p10 = float(bag[0.1].predict(aligned)[0])
            p50 = float(bag[0.5].predict(aligned)[0])
            p90 = float(bag[0.9].predict(aligned)[0])
            # Within-bag sort to defeat quantile crossing on this bag.
            tri = sorted([p10, p50, p90])
            q10_preds.append(tri[0])
            q50_preds.append(tri[1])
            q90_preds.append(tri[2])
        except Exception:
            continue

    if len(q50_preds) < 5:
        raise RuntimeError("bag predictions failed")

    mid = float(np.median(q50_preds))
    lo = float(np.percentile(q10_preds, 10.0))
    hi = float(np.percentile(q90_preds, 90.0))

    # Enforce monotone ordering (rare crossing under heavy ties).
    if lo > mid:
        lo = mid - _RESID_FLOOR
    if hi < mid:
        hi = mid + _RESID_FLOOR
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_clev_bagged_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of bagged quantile_rich + Cleveland features.

    Mirrors `backtest_clev_nowcast` exactly except for fitting/aggregation:
      - feature engineering identical (re-uses `_build_supervised_clev`)
      - 30 bootstrap-bag GBR triples per cut
      - mean = median of bag-q0.5 preds; lo/hi from percentile of bag-q0.1/0.9
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
    bag_counts: list[int] = []

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

            try:
                bags, cols = _fit_bagged_models(X, y)
            except Exception:
                continue

            # Inference features (same as clev baseline)
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
                feats.update(
                    _clev_features_for_month(clev, target_month_end, panel)
                )
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(
                X.median(numeric_only=True)
            ).fillna(0.0)

            try:
                mid, lo, hi = _aggregate_bag_predictions(bags, x_inf, cols)
            except Exception:
                continue

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
            bag_counts.append(len(bags))
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_bags": len(bags),
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
        "nBagsAvg": float(np.mean(bag_counts)) if bag_counts else 0.0,
        "rows": rows,
    }


def run_clev_bagged_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ClevBaggedNowcastResult:
    """Live nowcast using fresh Cleveland scrape + bagged quantile_rich stack."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    bags, cols = _fit_bagged_models(X, y)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
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

    x_inf = pd.Series(feats).reindex(cols).fillna(
        X.median(numeric_only=True)
    ).fillna(0.0)
    mid, lo, hi = _aggregate_bag_predictions(bags, x_inf, cols)
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
    return ClevBaggedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_bags=len(bags),
    )
