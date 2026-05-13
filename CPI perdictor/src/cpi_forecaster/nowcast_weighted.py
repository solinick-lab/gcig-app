"""Sample-weighted quantile CPI nowcaster.

The pure quantile baseline (`nowcast_quantile.py`) treats every historical
month equally. That's defensible in steady regimes, but the single biggest
miss in the 24-month backtest was Jan 2025, where the disinflation regime
caught the model out by ~0.74 YoY. The training set is dominated by
2007-2023 (rising / volatile inflation) and the model under-weights the
2024 disinflation signal that actually generalizes to the cut.

Fix: exponential sample weighting. Weight observation t with
    w_t = exp(-decay * (T - t))
where t is the row's ordinal position in the supervised matrix and T is
the most recent training row. Recent rows dominate the loss; old rows
still provide regularization but don't drag the fit.

Lesson from `agent_f_regime.py` (which tried the same trick on point
forecasts): naive sample weighting hard-coded `decay=0.015` and never
validated. Here we tune over {0.005, 0.01, 0.02, 0.04} using the last
6 supervised rows as an inner held-out tail and pick whichever decay
minimizes h=0 RMSE there. That keeps the per-cut work bounded (~4 fits
extra per cut, each on ~150-200 rows) so we stay well under the 30s/cut
budget.

Concern (sample_weight + quantile loss interaction): sklearn's GBR with
loss='quantile' DOES propagate `sample_weight` through the pinball loss
gradient — but the inner per-leaf line search is computed on weighted
quantiles, which can be unstable when weights are extremely skewed (one
or two recent rows dominating). The decay grid here keeps the effective
sample size at decay=0.04 around 25 rows (out of ~190), which is on the
edge but still stable; we cap at 0.04 deliberately.

Reuses `_build_supervised`, `_as_of_for_month`, and `_mom_to_yoy`-style
chaining from the baselines so feature engineering and YoY conversion
remain identical. Only the loss-weighting layer changes.
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
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_DECAY_GRID = (0.005, 0.01, 0.02, 0.04)
_INNER_CV_TAIL = 6  # months held out for inner decay-tuning CV
_MIN_TRAIN_FOR_CV = 30  # need at least this many rows to leave 6 out

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class WeightedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    decay: float


@dataclass
class WeightedNowcastModel:
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]
    as_of_day: int
    decay: float

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = [float(self.models[q].predict(x_aligned)[0]) for q in _QUANTILES]
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


# --- weighting & tuning ---------------------------------------------

def _exp_sample_weights(n: int, decay: float) -> np.ndarray:
    """Return exp(-decay * (T - t)) for t = 0..n-1; T = n-1.

    Most recent row gets weight 1.0; oldest gets exp(-decay*(n-1)).
    Normalized so that sum(weights) == n (mean-1) — keeps GBR's effective
    learning rate roughly comparable across decay choices.
    """
    if n <= 0:
        return np.array([])
    t_idx = np.arange(n, dtype=float)
    T = float(n - 1)
    w = np.exp(-decay * (T - t_idx))
    s = w.sum()
    if s <= 0 or not np.isfinite(s):
        return np.ones(n)
    return w * (n / s)


def _fit_quantile_gbr_weighted(
    X: np.ndarray, y: np.ndarray, weights: np.ndarray, q: float,
) -> GradientBoostingRegressor:
    return GradientBoostingRegressor(
        loss="quantile", alpha=q, **_GBR_PARAMS,
    ).fit(X, y, sample_weight=weights)


def _tune_decay(
    X: np.ndarray, y: np.ndarray,
    grid: tuple[float, ...] = _DECAY_GRID,
    cv_tail: int = _INNER_CV_TAIL,
) -> float:
    """Pick the decay that minimizes h=0 RMSE on the trailing `cv_tail` rows.

    Inner CV: fit q=0.5 GBR with sample weights on rows [0:n-cv_tail],
    predict rows [n-cv_tail:], compute RMSE. Done per decay, pick best.
    Only the median quantile is tuned on — the outer 0.1/0.9 fits inherit
    the chosen decay (it's a hyperparameter, not a per-quantile knob).
    """
    n = len(y)
    if n < _MIN_TRAIN_FOR_CV or cv_tail < 2:
        return _DECAY_GRID[1]  # 0.01 — sane default
    cut = n - cv_tail
    X_tr, y_tr = X[:cut], y[:cut]
    X_va, y_va = X[cut:], y[cut:]

    best_decay = _DECAY_GRID[1]
    best_rmse = float("inf")
    for d in grid:
        try:
            w = _exp_sample_weights(len(y_tr), d)
            m = _fit_quantile_gbr_weighted(X_tr, y_tr, w, q=0.5)
            pred = m.predict(X_va)
            rmse = float(np.sqrt(np.mean((pred - y_va) ** 2)))
            if rmse < best_rmse:
                best_rmse = rmse
                best_decay = d
        except Exception:
            continue
    return best_decay


# --- model fit -------------------------------------------------------

def fit_weighted_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
    decay: float | None = None,
) -> WeightedNowcastModel:
    """Fit three sample-weighted quantile GBRs.

    If `decay` is None, tune it via inner held-out CV on the last 6 rows.
    """
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    chosen = decay if decay is not None else _tune_decay(Xv, yv)
    weights = _exp_sample_weights(len(yv), chosen)

    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        models[q] = _fit_quantile_gbr_weighted(Xv, yv, weights, q=q)

    return WeightedNowcastModel(
        models=models,
        feature_cols=cols,
        as_of_day=as_of_day,
        decay=float(chosen),
    )


# --- helpers (mirrors of nowcast_quantile.py) ------------------------

def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


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


# --- public API ------------------------------------------------------

def run_weighted_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> WeightedNowcastResult:
    """Pull live panels, fit sample-weighted quantile model, nowcast current month."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_weighted_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return WeightedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        decay=model.decay,
    )


def backtest_weighted_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the sample-weighted quantile nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train data strictly BEFORE t
      - tune `decay` over {0.005, 0.01, 0.02, 0.04} via 6-row inner CV tail
      - fit q={0.1, 0.5, 0.9} weighted GBRs with the chosen decay
      - predict t's MoM, sort the triple, take the median
      - clip to [-1.5, 2.5], chain to YoY via published CPI from t-12

    A single failed cut is skipped so one fit failure doesn't tank the rest.
    Return shape mirrors `nowcast_quantile.backtest_quantile_nowcast`, plus
    a `decay` field per row.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

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

            model = fit_weighted_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day,
            )

            pred_mom, _, _ = model.predict_one(pd.Series(feats))
            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(pred_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "decay": round(model.decay, 4),
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
        "rows": rows,
    }
