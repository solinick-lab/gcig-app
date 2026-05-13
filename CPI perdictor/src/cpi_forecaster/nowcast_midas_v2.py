"""MIDAS v2 — proper MIDAS with LEARNED polynomial weights.

Improvement over `nowcast_midas.py` (which used 5 fixed weight schemes):

This version implements canonical MIDAS by learning the beta-polynomial
parameters (theta1, theta2) for each daily series jointly with a linear
regression coefficient. The beta polynomial is

    w_k = (k/K)^(theta1 - 1) * (1 - k/K)^(theta2 - 1)

normalized so weights sum to 1. By varying (theta1, theta2) we can
recover any of the classic MIDAS shapes:

    (1, 1)   = uniform / equal weights
    (2, 1)   = linearly increasing (emphasizes late month)
    (1, 2)   = linearly decreasing (emphasizes early month)
    (2, 2)   = symmetric hump (emphasizes mid-month)
    (4, 1)   = sharply late-loaded
    (1, 4)   = sharply early-loaded
    (0.5, *) = U-shaped

For each daily series we fit theta1, theta2 via a tight grid search over
{0.5, 1, 2, 4} x {0.5, 1, 2, 4} (16 combos). For every grid point we
compute the MIDAS-aggregated %change vs. prior-month-aggregate, fit a
1-D OLS regression of CPI MoM on that single feature using the
training rows, and pick the (theta1, theta2) with the lowest training
RMSE. We then keep that BEST aggregated feature for the final stack —
plus the percent-change of the BEST aggregator vs. prior month, for
robustness.

Learned MIDAS features are concatenated with rich features and the
Cleveland nowcast features (when scrape is available, else FRED-median
proxy). The downstream learner is the same three-quantile GBR head.
Same interface as `nowcast_midas.backtest_midas_nowcast` /
`run_midas_nowcast`.

Public API:
    backtest_midas_v2_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
    run_midas_v2_nowcast(as_of_day=20) -> MidasV2NowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass
from typing import Iterable

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

try:
    from scipy.optimize import minimize  # noqa: F401
    _HAS_SCIPY = True
except Exception:
    _HAS_SCIPY = False

from .api_client import get_daily_panel, get_cleveland_nowcast
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import _clev_features_for_month, _safe_get_clev
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_DAILY_IDS = (
    "DCOILWTICO",
    "DCOILBRENTEU",
    "DTWEXBGS",
    "DGS10",
    "DGS2",
    "T10Y2Y",
    "T10Y3M",
    "T5YIE",
    "T10YIE",
    "T5YIFR",
    "BAMLH0A0HYM2",
)

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Beta-polynomial grid points. Anchor at (1, 1) = uniform.
_THETA_GRID = (0.5, 1.0, 2.0, 4.0)


@dataclass
class MidasV2NowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    learned_thetas: dict


# ---------------------------------------------------------------------
# Beta-polynomial weights & MIDAS aggregation
# ---------------------------------------------------------------------


def _beta_weights(K: int, theta1: float, theta2: float) -> np.ndarray:
    """Beta-polynomial MIDAS weights of length K, summing to 1.

        w_k ∝ (k/K)^(theta1 - 1) * (1 - k/K)^(theta2 - 1)

    For numerical stability, k goes from 0.5/K to (K - 0.5)/K so the
    endpoints don't blow up or collapse to zero.
    """
    if K <= 0:
        return np.zeros(0, dtype=float)
    if K == 1:
        return np.array([1.0], dtype=float)
    k = np.arange(1, K + 1, dtype=float)
    u = (k - 0.5) / K
    u = np.clip(u, 1e-6, 1.0 - 1e-6)
    w = (u ** (theta1 - 1.0)) * ((1.0 - u) ** (theta2 - 1.0))
    s = float(w.sum())
    if not np.isfinite(s) or s <= 0:
        return np.full(K, 1.0 / K)
    return w / s


def _month_daily_values(
    s: pd.Series,
    month_start: pd.Timestamp,
    as_of: pd.Timestamp,
) -> np.ndarray:
    if s is None or len(s) == 0:
        return np.zeros(0, dtype=float)
    win = s.loc[(s.index >= month_start) & (s.index <= as_of)]
    if len(win) == 0:
        return np.zeros(0, dtype=float)
    arr = win.values.astype(float)
    arr = arr[np.isfinite(arr)]
    return arr


def _midas_aggregate_for_month(
    s: pd.Series,
    as_of: pd.Timestamp,
    theta1: float,
    theta2: float,
) -> tuple[float, float]:
    """Return (current-month aggregate, prior-month aggregate) for the
    given (theta1, theta2). Either may be NaN if the window is empty.
    """
    month_start = pd.Timestamp(as_of.year, as_of.month, 1)
    prior_end = month_start - pd.Timedelta(days=1)
    prior_start = pd.Timestamp(prior_end.year, prior_end.month, 1)

    cur = _month_daily_values(s, month_start, as_of)
    pri = _month_daily_values(s, prior_start, prior_end)

    cur_agg = (
        float(np.dot(_beta_weights(cur.shape[0], theta1, theta2), cur))
        if cur.shape[0] > 0 else np.nan
    )
    pri_agg = (
        float(np.dot(_beta_weights(pri.shape[0], theta1, theta2), pri))
        if pri.shape[0] > 0 else np.nan
    )
    return cur_agg, pri_agg


def _midas_pct_change_series(
    s: pd.Series,
    as_of_dates: Iterable[pd.Timestamp],
    theta1: float,
    theta2: float,
) -> np.ndarray:
    """For each as-of date, compute the MIDAS %-change vs prior-month
    aggregate. Returns a numpy array of floats (NaN where unavailable).
    """
    out: list[float] = []
    for as_of in as_of_dates:
        cur_agg, pri_agg = _midas_aggregate_for_month(s, as_of, theta1, theta2)
        if (
            np.isfinite(cur_agg)
            and np.isfinite(pri_agg)
            and pri_agg != 0
        ):
            out.append((cur_agg / pri_agg - 1.0) * 100.0)
        else:
            out.append(np.nan)
    return np.array(out, dtype=float)


# ---------------------------------------------------------------------
# Per-series theta learner (grid search)
# ---------------------------------------------------------------------


def _ols_rmse_1d(x: np.ndarray, y: np.ndarray) -> float:
    """RMSE of a univariate OLS y = a + b*x, ignoring NaNs.

    Returns +inf if the regression is degenerate.
    """
    mask = np.isfinite(x) & np.isfinite(y)
    if mask.sum() < 8:
        return float("inf")
    xv = x[mask]
    yv = y[mask]
    if np.var(xv) < 1e-12:
        return float("inf")
    A = np.column_stack([np.ones_like(xv), xv])
    try:
        beta, *_ = np.linalg.lstsq(A, yv, rcond=None)
        residuals = yv - A.dot(beta)
        return float(np.sqrt(np.mean(residuals ** 2)))
    except Exception:
        return float("inf")


def _learn_thetas_for_series(
    s: pd.Series,
    as_of_dates: list[pd.Timestamp],
    y_targets: np.ndarray,
) -> tuple[float, float, np.ndarray]:
    """Grid-search (theta1, theta2) for one daily series.

    Picks the (theta1, theta2) whose MIDAS %-change feature minimizes
    OLS RMSE against y_targets. Returns the chosen pair plus the
    %-change feature vector at those thetas (length = len(as_of_dates)).
    """
    best_rmse = float("inf")
    best_t1, best_t2 = 1.0, 1.0
    best_feat = np.full(len(as_of_dates), np.nan, dtype=float)

    for t1 in _THETA_GRID:
        for t2 in _THETA_GRID:
            try:
                feat = _midas_pct_change_series(s, as_of_dates, t1, t2)
            except Exception:
                continue
            rmse = _ols_rmse_1d(feat, y_targets)
            if rmse < best_rmse:
                best_rmse = rmse
                best_t1 = t1
                best_t2 = t2
                best_feat = feat

    return best_t1, best_t2, best_feat


# ---------------------------------------------------------------------
# Supervised dataset builder with learned MIDAS features
# ---------------------------------------------------------------------


def _build_supervised_v2(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series, dict[str, tuple[float, float]]]:
    """Build supervised matrix with LEARNED MIDAS features.

    Returns (X, y, learned_thetas) where learned_thetas[sid] = (t1, t2).
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible_months = list(y_mom.index[min_history_months:])

    # Build the as-of-date series and target vector first.
    as_of_dates: list[pd.Timestamp] = []
    targets: list[float] = []
    month_ends: list[pd.Timestamp] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        as_of_dates.append(as_of)
        targets.append(float(y_mom.loc[month_end]))
        month_ends.append(month_end)

    y_arr = np.array(targets, dtype=float)

    # Step 1: learn (theta1, theta2) per series on the full training set.
    learned: dict[str, tuple[float, float]] = {}
    learned_features: dict[str, np.ndarray] = {}
    for sid in _DAILY_IDS:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            continue
        try:
            t1, t2, feat = _learn_thetas_for_series(s, as_of_dates, y_arr)
        except Exception:
            continue
        learned[sid] = (t1, t2)
        learned_features[sid] = feat

    # Step 2: build per-row feature dict.
    rows: list[dict] = []
    for i, month_end in enumerate(month_ends):
        as_of = as_of_dates[i]
        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            feats = {}

        # Inject the learned-MIDAS %change features
        for sid, vec in learned_features.items():
            feats[f"midasL_{sid}_pct"] = float(vec[i]) if np.isfinite(vec[i]) else np.nan

        # Cleveland features (historical archive vintage)
        try:
            feats.update(_clev_features_for_month(clev, month_end, panel))
        except Exception:
            pass

        # Monthly CPI lags
        try:
            feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
        try:
            feats["cpi_mom_lag2"] = (
                float(y_mom.loc[:month_end].iloc[-3])
                if len(y_mom.loc[:month_end]) >= 3 else np.nan
            )
        except Exception:
            feats["cpi_mom_lag2"] = np.nan
        try:
            cpi_until = cpi.loc[:month_end]
            if len(cpi_until) >= 14:
                feats["cpi_yoy_lag1"] = float(
                    (cpi_until.iloc[-2] / cpi_until.iloc[-14] - 1.0) * 100.0
                )
            else:
                feats["cpi_yoy_lag1"] = np.nan
        except Exception:
            feats["cpi_yoy_lag1"] = np.nan

        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))
        feats["target_month_end"] = month_end
        rows.append(feats)

    if not rows:
        return pd.DataFrame(), pd.Series(dtype=float), learned

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y, learned


# ---------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------


def _build_inference_features_v2(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    learned: dict[str, tuple[float, float]],
    clev: dict,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)

    for sid, (t1, t2) in learned.items():
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            feats[f"midasL_{sid}_pct"] = np.nan
            continue
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            feats[f"midasL_{sid}_pct"] = np.nan
            continue
        try:
            cur_agg, pri_agg = _midas_aggregate_for_month(s_until, as_of, t1, t2)
            if (
                np.isfinite(cur_agg)
                and np.isfinite(pri_agg)
                and pri_agg != 0
            ):
                feats[f"midasL_{sid}_pct"] = (cur_agg / pri_agg - 1.0) * 100.0
            else:
                feats[f"midasL_{sid}_pct"] = np.nan
        except Exception:
            feats[f"midasL_{sid}_pct"] = np.nan

    try:
        feats.update(_clev_features_for_month(clev, target_month_end, train_panel))
    except Exception:
        pass

    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


# ---------------------------------------------------------------------
# Model fit / predict
# ---------------------------------------------------------------------


def _fit_quantile_models(X: pd.DataFrame, y: pd.Series) -> dict:
    models = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(X.values, y.values)
    return models


def _predict_triple(models: dict, x_inf: pd.Series, cols: list[str]) -> tuple[float, float, float]:
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    preds = sorted(float(models[q].predict(aligned)[0]) for q in _QUANTILES)
    lo, mid, hi = preds
    return mid, lo, hi


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


# ---------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------


def backtest_midas_v2_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of MIDAS v2 (learned beta-polynomial weights).

    For each historical cut t in the trailing window:
      - on TRAIN-ONLY data, learn (theta1, theta2) per daily series
      - build (rich + learned-MIDAS + Cleveland) features
      - fit three quantile GBRs (q={0.1, 0.5, 0.9})
      - predict t's MoM (median, sorted), clip, chain to YoY
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

            X, y, learned = _build_supervised_v2(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            feats, as_of = _build_inference_features_v2(
                train_panel, daily_frame, target_month_end, learned, clev, as_of_day,
            )

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            mid, _, _ = _predict_triple(models, x_inf, cols)
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


def run_midas_v2_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> MidasV2NowcastResult:
    """Live current-month nowcast using MIDAS v2 (learned beta-poly weights)."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y, learned = _build_supervised_v2(panel, daily_frame, clev, as_of_day=as_of_day)
    if len(X) == 0:
        raise RuntimeError("No supervised rows for MIDAS v2 fit")
    models = _fit_quantile_models(X, y)
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
    for sid, (t1, t2) in learned.items():
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            feats[f"midasL_{sid}_pct"] = np.nan
            continue
        s_until = s.loc[s.index <= as_of]
        try:
            cur_agg, pri_agg = _midas_aggregate_for_month(s_until, as_of, t1, t2)
            if (
                np.isfinite(cur_agg)
                and np.isfinite(pri_agg)
                and pri_agg != 0
            ):
                feats[f"midasL_{sid}_pct"] = (cur_agg / pri_agg - 1.0) * 100.0
            else:
                feats[f"midasL_{sid}_pct"] = np.nan
        except Exception:
            feats[f"midasL_{sid}_pct"] = np.nan
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

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

    return MidasV2NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        learned_thetas={k: list(v) for k, v in learned.items()},
    )
