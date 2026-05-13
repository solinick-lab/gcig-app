"""Oracle-style "best of N" nowcaster on the Yellen 1.1 feature stack.

Hypothesis: Yellen 1.1 (clev base + bagged GBR median + Ridge calibration)
sits at ~0.1142 RMSE YoY because it commits to ONE base learner family
(quantile gradient boosting) for every backtest cut. But the regime-by-
regime error structure of CPI does not favour the same family every
month: a Ridge with strong shrinkage is unbeatable in stable, low-
volatility windows; an ElasticNet helps when a few features dominate;
quantile-loss GBR shines on heavy-tailed shock months; Random Forest
absorbs nonlinear interactions when shelter and energy decouple. A
fixed-base pipeline cannot adapt.

This module implements an ORACLE-STYLE selector (different from a
weighted ensemble): for each backtest cut we

  1. Train FIVE lightweight base models on the full Yellen 1.1
     supervised matrix (`_build_supervised_clev` from `nowcast_clev`):
       - Ridge
       - Lasso
       - ElasticNet
       - GradientBoostingRegressor (quantile, alpha=0.5)
       - RandomForestRegressor
  2. Compute each base's TRAILING-3-MONTH validation MAE on the
     training data. The trailing-3 validation slice is the LAST three
     supervised rows whose target month is strictly before
     `target_month_end`. We re-fit each base on the rows EXCLUDING that
     trailing-3 window, predict on those three rows, and average their
     absolute residuals to get a TIME-AWARE generalisation proxy that
     matches the regime the live cut sits in.
  3. Pick the base with the LOWEST trailing-3 MAE. Use ONLY that single
     base's prediction at inference. We do NOT average the bases (which
     would be an ensemble); we COMMIT to one winner per cut.
  4. Bands come from a separate quantile triple (q=0.1/0.5/0.9 GBR) fit
     on the same matrix, identical to Yellen 1.1, so band widths stay
     comparable to the baseline.

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].

Public API:
  backtest_oracle_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_oracle_nowcast(as_of_day=20) -> OracleNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import ElasticNet, Lasso, Ridge

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import (
    _build_supervised_clev,
    _clev_features_for_month,
    _fit_quantile_models,
    _mom_to_yoy,
    _predict_triple,
    _safe_get_clev,
    _MOM_HI_CLIP,
    _MOM_LO_CLIP,
    _RESID_FLOOR,
)
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_RANDOM_STATE = 42
_VAL_TAIL = 3       # trailing-3-month validation window
_MIN_TRAIN_ROWS = 24  # need this many rows after carving out the val tail

# Lightweight base learner specs. Hyperparameters chosen to be modest:
# the matrix is ~60 rows so over-parameterised models will overfit and
# their val MAE will reveal that — exactly the behaviour we want from
# the selector.
_BASES: dict[str, callable] = {
    "ridge": lambda: Ridge(alpha=1.0, random_state=_RANDOM_STATE),
    "lasso": lambda: Lasso(alpha=0.01, max_iter=10000, random_state=_RANDOM_STATE),
    "elasticnet": lambda: ElasticNet(
        alpha=0.01, l1_ratio=0.5, max_iter=10000, random_state=_RANDOM_STATE,
    ),
    "gbr_q50": lambda: GradientBoostingRegressor(
        loss="quantile",
        alpha=0.5,
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        random_state=_RANDOM_STATE,
    ),
    "rf": lambda: RandomForestRegressor(
        n_estimators=200,
        max_depth=5,
        min_samples_leaf=2,
        random_state=_RANDOM_STATE,
        n_jobs=1,
    ),
}


@dataclass
class OracleNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    chosen_base: str
    val_mae: float
    n_train_rows: int


# ---------------------------------------------------------------------------
# Oracle selector
# ---------------------------------------------------------------------------


def _trailing_val_mae(
    base_factory,
    X: pd.DataFrame,
    y: pd.Series,
    val_tail: int = _VAL_TAIL,
) -> float:
    """Fit base on rows[:-val_tail], predict on rows[-val_tail:], return MAE.

    The supervised matrix `X` is already chronologically ordered (it is
    built one-row-per-train-month by `_build_supervised_clev`), so the
    LAST `val_tail` rows are the most recent training months — the
    closest analogue to the regime the OOS cut will land in. This is the
    "time-aware" piece: we never let the validation slice leak into
    training, and we always validate on the most recent months.
    """
    n = len(X)
    if n <= val_tail or n - val_tail < _MIN_TRAIN_ROWS:
        return float("inf")
    try:
        X_fit = X.iloc[:-val_tail]
        y_fit = y.iloc[:-val_tail]
        X_val = X.iloc[-val_tail:]
        y_val = y.iloc[-val_tail:]
        model = base_factory()
        model.fit(X_fit.values, y_fit.values)
        preds = model.predict(X_val.values)
        return float(np.mean(np.abs(preds - y_val.values)))
    except Exception:
        return float("inf")


def _select_oracle(
    X: pd.DataFrame,
    y: pd.Series,
    val_tail: int = _VAL_TAIL,
) -> tuple[str, float, dict[str, float]]:
    """Return (winner_name, winner_mae, all_maes). Lowest trailing val MAE wins."""
    maes: dict[str, float] = {}
    for name, factory in _BASES.items():
        maes[name] = _trailing_val_mae(factory, X, y, val_tail=val_tail)
    # filter out infs (failed fits); if all failed, fall back to ridge
    finite = {k: v for k, v in maes.items() if np.isfinite(v)}
    if not finite:
        return "ridge", float("inf"), maes
    winner = min(finite, key=finite.get)
    return winner, finite[winner], maes


def _fit_full_and_predict(
    base_name: str,
    X: pd.DataFrame,
    y: pd.Series,
    x_inf: pd.Series,
) -> float:
    """Refit the chosen base on the FULL matrix, then predict on x_inf."""
    factory = _BASES[base_name]
    model = factory()
    model.fit(X.values, y.values)
    pred = float(model.predict(x_inf.values.reshape(1, -1))[0])
    return float(np.clip(pred, _MOM_LO_CLIP, _MOM_HI_CLIP))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_oracle_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the oracle 'best-of-5' selector."""
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
    base_choice_counts: dict[str, int] = {k: 0 for k in _BASES}

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < (_MIN_TRAIN_ROWS + _VAL_TAIL):
                continue

            cols = list(X.columns)

            # --- bands: keep Yellen 1.1's quantile triple for comparability ---
            band_models = _fit_quantile_models(X, y)

            # --- oracle selection: pick lowest trailing-3 MAE base ---
            winner, val_mae, _all_maes = _select_oracle(X, y, val_tail=_VAL_TAIL)
            base_choice_counts[winner] = base_choice_counts.get(winner, 0) + 1

            # --- inference features (identical to clev / yellen baseline) ---
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

            # --- ORACLE prediction: refit chosen base on FULL matrix, predict ---
            mid = _fit_full_and_predict(winner, X, y, x_inf)

            # bands from the unbagged quantile triple
            _, lo_base, hi_base = _predict_triple(band_models, x_inf, cols)

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
                "chosen_base": winner,
                "val_mae": round(val_mae, 4),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_train_rows": len(X),
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
        "baseChoiceCounts": base_choice_counts,
        "valTail": _VAL_TAIL,
        "rows": rows,
    }


def run_oracle_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> OracleNowcastResult:
    """Live oracle-style nowcast: 5 bases, time-aware selection, single winner."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    cols = list(X.columns)

    band_models = _fit_quantile_models(X, y)
    winner, val_mae, _all_maes = _select_oracle(X, y, val_tail=_VAL_TAIL)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
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

    mid = _fit_full_and_predict(winner, X, y, x_inf)
    _, lo_base, hi_base = _predict_triple(band_models, x_inf, cols)

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_base, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_base, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return OracleNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        chosen_base=winner,
        val_mae=float(val_mae) if np.isfinite(val_mae) else 0.0,
        n_train_rows=int(len(X)),
    )
