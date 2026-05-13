"""Deep ensemble on the wide expanded panel (Agent YY).

Six base learners — RidgeCV, ElasticNetCV, LassoCV, XGBRegressor (tuned),
GradientBoostingRegressor, RandomForestRegressor — all fit on the same
WIDE feature matrix built directly from the full 37-series panel. For
every panel column we engineer three lagged transforms:

  * MoM  lag 1   = (x_t / x_{t-1}  − 1) × 100,  shifted +1
  * 3mo  lag 1   = (x_t / x_{t-3}  − 1) × 100,  shifted +1
  * YoY  lag 1   = (x_t / x_{t-12} − 1) × 100,  shifted +1

Plus calendar terms (month_sin / month_cos) and CPI's own MoM/YoY lags.

For each forecast horizon h we run a TimeSeriesSplit (3 folds) over the
six base models to collect out-of-fold predictions, then fit a Ridge
meta-learner on the stacked (n_oof × 6) matrix against the realized
headline MoM. At inference: refit each base model on the full (X, y_h)
pair, run the live feature row through all six, and push that 6-vector
through the meta-Ridge to get the final mean.

80% bands come from the meta-Ridge's residual std × z₀.₈ (1.2816). We
don't √h scale because each horizon has its own meta with its own
residual distribution.

Per the race contract this strategy MUST NOT raise — every risky block
is wrapped in try/except and we fall back to last-MoM persistence if
nothing else works. Per-cut budget is permissive (six models + stacking),
but each base learner is configured to be cheap (small n_estimators,
shallow trees, tight alpha grids) so a 24-month backtest still completes
inside the harness budget.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target
from ..fred import FEATURES, TARGET


warnings.filterwarnings("ignore")


# Z for 80% one-sided interval.
_Z80 = 1.2816

# Minimum supervised rows we need before we'll attempt the deep ensemble.
# Below this we degrade to last-MoM persistence.
_MIN_ROWS = 60

# Folds used for OOF meta-feature generation. 3 is a deliberate
# speed/signal trade-off — six base learners per fold per horizon adds
# up fast, and Ridge meta with three OOF blocks already has enough rows
# to see daylight between learners.
_N_FOLDS = 3


# ----------------------------------------------------------------------
# Wide feature builder
# ----------------------------------------------------------------------
def _build_wide_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Engineer MoM / 3mo / YoY lag-1 features for every panel column.

    Lagging by +1 month makes every feature point-in-time available by
    the end of the prior month, mirroring the convention in
    ``cpi_forecaster.features.build_features``.
    """
    rows: dict[str, pd.Series] = {}

    # CPI's own backwards-looking signal — keep the same handful that
    # the baseline ridge uses so the wide panel never *loses* anything
    # the narrow one had.
    cpi = panel[TARGET.fred_id].astype(float)
    cpi_log_mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
    rows["cpi_mom_lag1"] = cpi_log_mom.shift(1)
    rows["cpi_mom_lag2"] = cpi_log_mom.shift(2)
    rows["cpi_mom_lag3"] = cpi_log_mom.shift(3)
    rows["cpi_yoy_lag1"] = ((cpi / cpi.shift(12) - 1.0) * 100.0).shift(1)

    # Every macro feature column — three transforms each, all lagged.
    for f in FEATURES:
        sid = f.fred_id
        if sid not in panel.columns:
            continue
        col = panel[sid].astype(float)
        rows[f"{sid}_mom_lag1"] = ((col / col.shift(1) - 1.0) * 100.0).shift(1)
        rows[f"{sid}_3mo_lag1"] = ((col / col.shift(3) - 1.0) * 100.0).shift(1)
        rows[f"{sid}_yoy_lag1"] = ((col / col.shift(12) - 1.0) * 100.0).shift(1)

    # Calendar features — explicit seasonal anchors the macro panel
    # doesn't fully cover (vehicle-pricing months, energy-demand peaks).
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx, name="month_sin"
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx, name="month_cos"
    )

    feats = pd.concat(rows, axis=1)
    return feats


def _persistence_forecast(
    panel: pd.DataFrame, horizon: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Hard fallback: last observed MoM, repeated, with a generic ±0.30 band."""
    try:
        last = float(build_target(panel).dropna().iloc[-1])
    except Exception:
        last = 0.20
    m = np.array([last] * horizon, dtype=float)
    return m, m - 0.30, m + 0.30


def _latest_live_row(X: pd.DataFrame) -> pd.Series:
    """Last usable feature row at the cut date, with a small ffill cushion
    for series that report on a lag (UMICH expectations, JOLTS, etc.)."""
    feats = X.copy().ffill(limit=2)
    feats = feats.dropna(how="all")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _impute_live(x_live: np.ndarray, X_train: np.ndarray) -> np.ndarray:
    """Replace any non-finite live-feature values with the column mean
    from training. Defensive — the wide panel includes ICSA / DGS2 which
    occasionally have NaN tails that survive the ffill."""
    mask = ~np.isfinite(x_live[0])
    if mask.any():
        col_means = np.nanmean(X_train, axis=0)
        col_means = np.where(np.isfinite(col_means), col_means, 0.0)
        x_live = x_live.copy()
        x_live[0, mask] = col_means[mask]
    return x_live


# ----------------------------------------------------------------------
# Base-learner factory
# ----------------------------------------------------------------------
def _make_base_models(seed: int = 0):
    """Instantiate the six base learners. Linear ones live on scaled X;
    the tree ones use raw X. We return them keyed so the OOF and final
    refit paths stay aligned."""
    from sklearn.linear_model import ElasticNetCV, LassoCV, RidgeCV
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor

    ridge_alphas = np.logspace(-2, 4, 13)
    en_alphas = np.logspace(-3, 1, 9)

    models: dict[str, object] = {}
    # Linear regularizers — share the scaled features, different priors.
    models["ridge"] = RidgeCV(alphas=ridge_alphas)
    models["elastic"] = ElasticNetCV(
        alphas=en_alphas,
        l1_ratio=[0.2, 0.5, 0.8],
        cv=3,
        max_iter=5000,
        random_state=seed,
        n_jobs=1,
    )
    models["lasso"] = LassoCV(
        alphas=en_alphas,
        cv=3,
        max_iter=5000,
        random_state=seed,
        n_jobs=1,
    )

    # XGBoost — tuned to be cheap and bias-leaning. If xgboost isn't
    # available we silently swap in a HistGradientBoosting which has
    # similar inductive bias and ships with sklearn.
    try:
        from xgboost import XGBRegressor

        models["xgb"] = XGBRegressor(
            n_estimators=250,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.85,
            colsample_bytree=0.85,
            min_child_weight=3,
            reg_lambda=1.0,
            objective="reg:squarederror",
            n_jobs=1,
            verbosity=0,
            random_state=seed,
        )
    except Exception:
        from sklearn.ensemble import HistGradientBoostingRegressor

        models["xgb"] = HistGradientBoostingRegressor(
            max_iter=250,
            max_depth=3,
            learning_rate=0.05,
            random_state=seed,
        )

    models["gbr"] = GradientBoostingRegressor(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        random_state=seed,
    )
    models["rf"] = RandomForestRegressor(
        n_estimators=200,
        max_depth=8,
        min_samples_leaf=3,
        max_features="sqrt",
        n_jobs=1,
        random_state=seed,
    )

    return models


# Linear models that consume scaled features. Everything else gets raw X.
_LINEAR_KEYS = ("ridge", "elastic", "lasso")
_MODEL_ORDER = ("ridge", "elastic", "lasso", "xgb", "gbr", "rf")


# ----------------------------------------------------------------------
# Main strategy
# ----------------------------------------------------------------------
class DeepEnsembleStrategy(ForecastStrategy):
    name = "agent_yy_deepens"

    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            return _persistence_forecast(panel, horizon)

    # ------------------------------------------------------------------
    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Headline MoM target — what the meta-learner is trained against.
        y_full = build_target(panel)

        # Wide engineered features.
        X_wide = _build_wide_features(panel)

        # Aligned (X, y) drop-NA pairs we can train on.
        df = X_wide.join(y_full.rename("__y__"), how="inner").dropna()
        if len(df) < _MIN_ROWS:
            return _persistence_forecast(panel, horizon)

        feature_cols = [c for c in df.columns if c != "__y__"]
        X_full = df[feature_cols]
        y_aligned = df["__y__"].astype(float)

        # Live (cut-date) feature row — the inputs to the inference path.
        live_row = _latest_live_row(X_wide[feature_cols])

        means = np.empty(horizon, dtype=float)
        spreads = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                mu, sd = self._fit_one_horizon(
                    X_full, y_aligned, h, live_row, feature_cols
                )
            except Exception:
                # Last-MoM fallback for this individual horizon — keeps
                # the rest of the path live even if one fold blows up.
                try:
                    mu = float(y_aligned.iloc[-1])
                except Exception:
                    mu = 0.20
                sd = 0.30
            means[i] = mu
            spreads[i] = _Z80 * max(sd, 0.05)

        return means, means - spreads, means + spreads

    # ------------------------------------------------------------------
    # Per-horizon: stack 6 OOF base preds → Ridge meta → live forecast
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
        feature_cols: list[str],
    ) -> tuple[float, float]:
        from sklearn.linear_model import Ridge
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.preprocessing import StandardScaler

        # Pair X[t] with y[t + (h-1)] — direct multi-step. h=1 means the
        # very next month; nothing to shift.
        shift = h - 1
        if shift > 0:
            y_h = y_full.shift(-shift)
        else:
            y_h = y_full

        mask = ~y_h.isna().values
        if mask.sum() < 48:
            raise RuntimeError(f"not enough paired rows for h={h}")

        X_arr = X_full.values[mask].astype(float)
        y_arr = y_h.values[mask].astype(float)
        idx_arr = X_full.index[mask]
        n = len(X_arr)

        x_live = live_row.values.astype(float).reshape(1, -1)
        x_live = _impute_live(x_live, X_arr)

        # ---- Out-of-fold base predictions (6 models × n rows) ----
        oof = np.full((n, len(_MODEL_ORDER)), np.nan, dtype=float)
        n_splits = max(2, min(_N_FOLDS, n // 30))
        tscv = TimeSeriesSplit(n_splits=n_splits)

        for tr_idx, va_idx in tscv.split(X_arr):
            X_tr, X_va = X_arr[tr_idx], X_arr[va_idx]
            y_tr = y_arr[tr_idx]

            # Scale once per fold for the linear models.
            try:
                scaler = StandardScaler().fit(X_tr)
                Xs_tr = scaler.transform(X_tr)
                Xs_va = scaler.transform(X_va)
            except Exception:
                # Pathological column → zero variance. Skip scaling and
                # let the models eat raw values; Ridge will still fit.
                Xs_tr, Xs_va = X_tr, X_va

            base_models = _make_base_models()
            for k_idx, key in enumerate(_MODEL_ORDER):
                model = base_models[key]
                try:
                    if key in _LINEAR_KEYS:
                        model.fit(Xs_tr, y_tr)
                        pred = model.predict(Xs_va)
                    else:
                        model.fit(X_tr, y_tr)
                        pred = model.predict(X_va)
                    oof[va_idx, k_idx] = np.asarray(pred, dtype=float)
                except Exception:
                    # Any fold/model failure → leave NaN; we'll fill
                    # before fitting the meta.
                    continue

        # Drop OOF rows where every model failed; fill the rest with each
        # column's median (rare — usually means a fold barely fit).
        valid_rows = ~np.all(np.isnan(oof), axis=1)
        if valid_rows.sum() < 12:
            raise RuntimeError(f"insufficient OOF rows for meta at h={h}")

        oof = oof[valid_rows]
        y_oof = y_arr[valid_rows]
        # Per-column NaN fill so the meta sees a dense matrix.
        col_med = np.nanmedian(oof, axis=0)
        col_med = np.where(np.isfinite(col_med), col_med, 0.0)
        for k_idx in range(oof.shape[1]):
            mask_nan = ~np.isfinite(oof[:, k_idx])
            if mask_nan.any():
                oof[mask_nan, k_idx] = col_med[k_idx]

        # ---- Meta-learner: Ridge on (n_oof × 6) → headline_actual ----
        meta = Ridge(alpha=1.0).fit(oof, y_oof)
        meta_pred = meta.predict(oof)
        meta_resid = y_oof - meta_pred
        if len(meta_resid) > 1 and np.std(meta_resid) > 0:
            sd = float(np.std(meta_resid))
        else:
            # Empirical fallback — typical headline MoM has ~0.20 sigma.
            sd = float(max(0.20, np.std(y_arr) if len(y_arr) > 1 else 0.20))

        # ---- Refit each base model on the FULL (X_arr, y_arr) ----
        try:
            scaler = StandardScaler().fit(X_arr)
            Xs_full = scaler.transform(X_arr)
            xs_live = scaler.transform(x_live)
        except Exception:
            Xs_full, xs_live = X_arr, x_live

        live_base = np.full(len(_MODEL_ORDER), np.nan, dtype=float)
        base_models = _make_base_models()
        for k_idx, key in enumerate(_MODEL_ORDER):
            model = base_models[key]
            try:
                if key in _LINEAR_KEYS:
                    model.fit(Xs_full, y_arr)
                    live_base[k_idx] = float(model.predict(xs_live)[0])
                else:
                    model.fit(X_arr, y_arr)
                    live_base[k_idx] = float(model.predict(x_live)[0])
            except Exception:
                continue

        # If any final-fit prediction is NaN, fill with the OOF column
        # median so the meta still gets a real 6-vector.
        for k_idx in range(len(_MODEL_ORDER)):
            if not np.isfinite(live_base[k_idx]):
                live_base[k_idx] = col_med[k_idx]

        mu = float(meta.predict(live_base.reshape(1, -1))[0])
        if not np.isfinite(mu):
            mu = float(np.nanmean(live_base))
        return mu, sd
