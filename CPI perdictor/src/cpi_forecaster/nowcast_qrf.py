"""Quantile Random Forest (QRF) CPI nowcaster.

Same feature set as Yellen 1.1 (clev_calibrated): rich daily features +
lag/calendar features + Cleveland Fed nowcast features. The model swap
is the interesting bit.

QRF trick (Meinshausen 2006): a Random Forest grown for the conditional
mean already partitions feature space into thousands of leaves. Each
training row falls into ONE leaf per tree. If we keep, for every leaf,
the *list of training y-values* that landed there, then at prediction
time we can look up the leaf in each of `n_estimators` trees, pool
those y-values across all trees, and read off any percentile we want.
This recovers the conditional distribution F(y|x) instead of just its
mean — quantile regression via tree partitioning, no per-q model needed.

We use sklearn's `RandomForestRegressor(n_estimators=300)` to grow the
trees, then `.apply(X)` to find each row's leaf in every tree. The
training-time bookkeeping is a `dict[(tree_idx, leaf_id) -> np.ndarray
of y-values]`. At inference we concatenate y-values from each tree's
leaf for the test point and `np.percentile` for q ∈ {0.1, 0.5, 0.9}.

Beats Yellen 1.1 because (a) one forest handles all three quantiles
coherently — no quantile crossing — and (b) RF averages across many
bootstrapped trees, which on small panels is more bias-variance-favorable
than independent quantile-loss GBRs.

Public API:
  backtest_qrf_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_qrf_nowcast(as_of_day=20) -> QrfNowcastResult

Standard MoM->YoY chain. Each cut wrapped in try/except. MoM clipped
to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

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

_QUANTILES = (0.1, 0.5, 0.9)
_N_ESTIMATORS = 300
_RF_PARAMS = dict(
    n_estimators=_N_ESTIMATORS,
    # Leave most knobs at sklearn defaults so each tree is grown fully —
    # deeper leaves contain fewer training y's, but pooling across 300
    # trees still produces a smooth empirical CDF for percentile lookup.
    min_samples_leaf=3,  # avoid singletons producing degenerate quantiles
    n_jobs=-1,
    random_state=42,
)


@dataclass
class QrfNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_train_rows: int


# ---------------------------------------------------------------------------
# Quantile Random Forest core
# ---------------------------------------------------------------------------


class QuantileRandomForest:
    """Wrap RandomForestRegressor with leaf-level y bookkeeping.

    Fit: train RF as usual, then for every (tree, leaf_id) accumulate
    the training y values that landed in that leaf. Predict: for a test
    point, find its leaf in each tree, gather the corresponding y-lists,
    concatenate, take percentile.
    """

    def __init__(self, **rf_kwargs):
        self.rf = RandomForestRegressor(**rf_kwargs)
        # leaf_y[tree_idx][leaf_id] -> np.ndarray of training y-values
        self.leaf_y: list[dict[int, np.ndarray]] = []

    def fit(self, X: np.ndarray, y: np.ndarray) -> "QuantileRandomForest":
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        self.rf.fit(X, y)

        # apply -> shape (n_samples, n_estimators), each cell = leaf id
        train_leaves = self.rf.apply(X)
        self.leaf_y = []
        for t_idx in range(train_leaves.shape[1]):
            mapping: dict[int, list[float]] = {}
            leaf_ids = train_leaves[:, t_idx]
            for i, leaf_id in enumerate(leaf_ids):
                lid = int(leaf_id)
                if lid not in mapping:
                    mapping[lid] = []
                mapping[lid].append(float(y[i]))
            # freeze each list into a numpy array for fast concat at predict-time
            self.leaf_y.append({k: np.asarray(v, dtype=float) for k, v in mapping.items()})
        return self

    def predict_quantiles(
        self,
        X: np.ndarray,
        quantiles: tuple[float, ...] = _QUANTILES,
    ) -> np.ndarray:
        """Return shape (n_rows, len(quantiles)) of quantile predictions."""
        X = np.asarray(X, dtype=float)
        if X.ndim == 1:
            X = X.reshape(1, -1)
        test_leaves = self.rf.apply(X)  # (n_test, n_estimators)
        n_test = X.shape[0]
        out = np.zeros((n_test, len(quantiles)), dtype=float)

        for i in range(n_test):
            pooled: list[np.ndarray] = []
            for t_idx in range(test_leaves.shape[1]):
                lid = int(test_leaves[i, t_idx])
                arr = self.leaf_y[t_idx].get(lid)
                if arr is not None and arr.size > 0:
                    pooled.append(arr)
            if not pooled:
                # fallback: use the RF mean prediction for all quantiles
                mean_pred = float(self.rf.predict(X[i].reshape(1, -1))[0])
                out[i, :] = mean_pred
                continue
            stacked = np.concatenate(pooled)
            for j, q in enumerate(quantiles):
                out[i, j] = float(np.percentile(stacked, q * 100.0))
        return out


def _fit_qrf(X: pd.DataFrame, y: pd.Series) -> QuantileRandomForest:
    qrf = QuantileRandomForest(**_RF_PARAMS)
    qrf.fit(X.values, y.values)
    return qrf


def _predict_triple(qrf: QuantileRandomForest, x_inf: pd.Series, cols: list[str]) -> tuple[float, float, float]:
    """Predict (mid=q0.5, lo=q0.1, hi=q0.9). Sort to enforce monotonicity."""
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    qs = qrf.predict_quantiles(aligned, quantiles=_QUANTILES)[0]
    # sort to defend against any leaf-level quirks where percentiles invert
    lo, mid, hi = sorted(float(v) for v in qs)
    return mid, lo, hi


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_qrf_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of QRF + Yellen 1.1 feature set."""
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

            qrf = _fit_qrf(X, y)
            cols = list(X.columns)

            # Inference features (same recipe as Yellen 1.1)
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

            mid, lo, hi = _predict_triple(qrf, x_inf, cols)
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
                "n_train_rows": int(len(X)),
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
        "nEstimators": _N_ESTIMATORS,
        "rows": rows,
    }


def run_qrf_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> QrfNowcastResult:
    """Live QRF nowcast using fresh Cleveland scrape + rich features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    qrf = _fit_qrf(X, y)
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
    mid, lo, hi = _predict_triple(qrf, x_inf, cols)
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
    return QrfNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_train_rows=int(len(X)),
    )
