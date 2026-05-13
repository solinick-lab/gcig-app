"""Agent J: Bayesian Model Averaging (BMA) over 6 candidate models.

Instead of stacking via Ridge meta-learner (Champion's approach), this
strategy computes BIC for each candidate model and weights predictions
by posterior probability:

    weight_i ∝ exp(-0.5 * (BIC_i - min(BIC)))

The candidate set is:
  1. SARIMA(1,0,1)(0,1,1,12)  — small grid, lowest-AIC pick
  2. RidgeCV
  3. ElasticNetCV
  4. LassoCV
  5. XGBoost
  6. GradientBoostingRegressor

For each model:
    BIC ≈ n*ln(SSE/n) + k*ln(n)
where k is an effective parameter count proxy (SARIMA params, ridge
trace-of-hat, tree leaf/depth proxies).

80% intervals incorporate full BMA variance:
    var_bma = Σ w_i * (σ_i^2 + (μ_i - μ_bma)^2)

Recursive multi-step forecasting (focus is on the BMA weighting).
Wrapped in nested try/except — never raises.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET
from ..features import build_supervised, build_features


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 60


# ----------------------------- helpers -----------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _last_observed_mom(panel: pd.DataFrame) -> float:
    try:
        cpi = panel[TARGET.fred_id]
        return float(_log_mom(cpi).dropna().iloc[-1])
    except Exception:
        return 0.0


def _empirical_mom_std(panel: pd.DataFrame) -> float:
    try:
        cpi = panel[TARGET.fred_id]
        s = _log_mom(cpi).dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())
    except Exception:
        return 0.25


def _bic_from_sse(sse: float, n: int, k: int) -> float:
    """BIC ≈ n*ln(SSE/n) + k*ln(n). Numerical floors keep this finite."""
    if not np.isfinite(sse) or sse <= 0:
        sse = 1e-9
    if n <= 1:
        return np.inf
    return float(n * np.log(sse / n) + k * np.log(n))


def _softmax_weights(bics: np.ndarray) -> np.ndarray:
    """w_i ∝ exp(-0.5 * (BIC_i - min(BIC))). Subtract min for stability."""
    finite = np.isfinite(bics)
    if not finite.any():
        return np.ones_like(bics) / len(bics)
    safe = np.where(finite, bics, np.nanmax(bics[finite]) + 1e6)
    delta = safe - np.min(safe)
    raw = np.exp(-0.5 * delta)
    raw = np.where(finite, raw, 0.0)
    total = raw.sum()
    if total <= 0 or not np.isfinite(total):
        return np.ones_like(bics) / len(bics)
    return raw / total


# ----------------------- per-model fit + recursive predict -----------------

def _ridge_hat_trace(Xs: np.ndarray, alpha: float) -> float:
    """Effective d.o.f. for ridge: tr(X(X'X + alpha I)^-1 X')."""
    try:
        n, p = Xs.shape
        XtX = Xs.T @ Xs
        A = XtX + alpha * np.eye(p)
        Ainv = np.linalg.pinv(A)
        H_diag = np.einsum("ij,jk,ik->i", Xs, Ainv, Xs)
        return float(np.clip(H_diag.sum(), 1.0, n - 1))
    except Exception:
        return float(min(Xs.shape[1], Xs.shape[0] - 1))


def _recursive_predict_linear(model, scaler, feature_cols, panel, horizon):
    """Recursive multi-step for any sklearn linear-style model with .predict().
    Rolls cpi_mom_lag1..3 forward; macro features held at last value.
    """
    feats = build_features(panel).copy()
    feats = feats.ffill(limit=2).dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row.")
    row = feats.iloc[-1].copy()

    means = []
    for _ in range(horizon):
        x = row[feature_cols].values.reshape(1, -1).astype(float)
        if scaler is not None:
            x = scaler.transform(x)
        yhat = float(model.predict(x)[0])
        means.append(yhat)
        row["cpi_mom_lag3"] = row["cpi_mom_lag2"]
        row["cpi_mom_lag2"] = row["cpi_mom_lag1"]
        row["cpi_mom_lag1"] = yhat
    return np.array(means)


def _recursive_predict_tree(model, feature_cols, panel, horizon):
    """Same recursive trick, but no scaler (tree models)."""
    feats = build_features(panel).copy()
    feats = feats.ffill(limit=2).dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row.")
    row = feats.iloc[-1].copy()

    means = []
    for _ in range(horizon):
        x = row[feature_cols].values.reshape(1, -1).astype(float)
        yhat = float(model.predict(x)[0])
        means.append(yhat)
        row["cpi_mom_lag3"] = row["cpi_mom_lag2"]
        row["cpi_mom_lag2"] = row["cpi_mom_lag1"]
        row["cpi_mom_lag1"] = yhat
    return np.array(means)


# ----------------------- candidate model fitters ------------------------

def _fit_sarima(panel, horizon):
    """SARIMA(1,0,1)(0,1,1,12) — small fixed pick. Returns dict or None."""
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    try:
        cpi = panel[TARGET.fred_id].dropna()
        y = (np.log(cpi) - np.log(cpi.shift(1))).dropna() * 100.0
        n = len(y)
        if n < _MIN_TRAIN_ROWS:
            return None
        res = SARIMAX(
            y,
            order=(1, 0, 1),
            seasonal_order=(0, 1, 1, 12),
            enforce_stationarity=False,
            enforce_invertibility=False,
        ).fit(disp=False)
        # In-sample residuals
        resid = np.asarray(res.resid)
        # Guard the SSE — early SARIMA residuals can be massive; trim warmup.
        warmup = min(24, max(12, n // 10))
        resid_trim = resid[warmup:]
        if resid_trim.size < 12:
            resid_trim = resid
        sse = float(np.sum(resid_trim ** 2))
        # k = number of fitted parameters
        try:
            k = int(len(res.params))
        except Exception:
            k = 5
        bic = _bic_from_sse(sse, len(resid_trim), k)
        sigma = float(np.std(resid_trim))
        sigma = max(sigma, _RESID_FLOOR)
        # Forecast
        fc = res.get_forecast(steps=horizon)
        mean = np.asarray(fc.predicted_mean)
        return {
            "name": "sarima",
            "mean": mean,
            "sigma": sigma,
            "bic": bic,
        }
    except Exception:
        return None


def _fit_ridge(panel, horizon):
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler

    try:
        X, y = build_supervised(panel)
        if len(y) < _MIN_TRAIN_ROWS:
            return None
        feature_cols = list(X.columns)
        scaler = StandardScaler().fit(X.values)
        Xs = scaler.transform(X.values)
        model = RidgeCV(alphas=np.logspace(-3, 3, 19)).fit(Xs, y.values)
        resid = y.values - model.predict(Xs)
        sse = float(np.sum(resid ** 2))
        n = len(y)
        k = _ridge_hat_trace(Xs, float(model.alpha_))
        bic = _bic_from_sse(sse, n, int(round(k)))
        sigma = max(float(np.std(resid)), _RESID_FLOOR)
        mean = _recursive_predict_linear(model, scaler, feature_cols, panel, horizon)
        return {"name": "ridge", "mean": mean, "sigma": sigma, "bic": bic}
    except Exception:
        return None


def _fit_elasticnet(panel, horizon):
    from sklearn.linear_model import ElasticNetCV
    from sklearn.preprocessing import StandardScaler

    try:
        X, y = build_supervised(panel)
        if len(y) < _MIN_TRAIN_ROWS:
            return None
        feature_cols = list(X.columns)
        scaler = StandardScaler().fit(X.values)
        Xs = scaler.transform(X.values)
        model = ElasticNetCV(
            l1_ratio=[0.2, 0.5, 0.8],
            alphas=np.logspace(-3, 1, 15),
            cv=3,
            max_iter=5000,
            random_state=0,
        ).fit(Xs, y.values)
        resid = y.values - model.predict(Xs)
        sse = float(np.sum(resid ** 2))
        n = len(y)
        # Effective k for ElasticNet: count of non-zero coefs + 1 intercept
        nz = int(np.sum(np.abs(model.coef_) > 1e-8))
        k = max(nz + 1, 1)
        bic = _bic_from_sse(sse, n, k)
        sigma = max(float(np.std(resid)), _RESID_FLOOR)
        mean = _recursive_predict_linear(model, scaler, feature_cols, panel, horizon)
        return {"name": "elasticnet", "mean": mean, "sigma": sigma, "bic": bic}
    except Exception:
        return None


def _fit_lasso(panel, horizon):
    from sklearn.linear_model import LassoCV
    from sklearn.preprocessing import StandardScaler

    try:
        X, y = build_supervised(panel)
        if len(y) < _MIN_TRAIN_ROWS:
            return None
        feature_cols = list(X.columns)
        scaler = StandardScaler().fit(X.values)
        Xs = scaler.transform(X.values)
        model = LassoCV(
            alphas=np.logspace(-3, 1, 20),
            cv=3,
            max_iter=5000,
            random_state=0,
        ).fit(Xs, y.values)
        resid = y.values - model.predict(Xs)
        sse = float(np.sum(resid ** 2))
        n = len(y)
        nz = int(np.sum(np.abs(model.coef_) > 1e-8))
        k = max(nz + 1, 1)
        bic = _bic_from_sse(sse, n, k)
        sigma = max(float(np.std(resid)), _RESID_FLOOR)
        mean = _recursive_predict_linear(model, scaler, feature_cols, panel, horizon)
        return {"name": "lasso", "mean": mean, "sigma": sigma, "bic": bic}
    except Exception:
        return None


def _fit_xgb(panel, horizon):
    try:
        from xgboost import XGBRegressor
    except Exception:
        return None
    try:
        X, y = build_supervised(panel)
        if len(y) < _MIN_TRAIN_ROWS:
            return None
        feature_cols = list(X.columns)
        n_est = 200
        max_d = 3
        model = XGBRegressor(
            n_estimators=n_est,
            max_depth=max_d,
            learning_rate=0.05,
            subsample=0.85,
            colsample_bytree=0.85,
            min_child_weight=3,
            reg_lambda=1.0,
            reg_alpha=0.05,
            objective="reg:squarederror",
            n_jobs=1,
            verbosity=0,
            random_state=0,
        )
        model.fit(X.values, y.values)
        resid = y.values - model.predict(X.values)
        sse = float(np.sum(resid ** 2))
        n = len(y)
        # Effective k proxy: n_estimators * max_depth (heavy penalty for trees).
        k = int(n_est * max_d)
        bic = _bic_from_sse(sse, n, k)
        sigma = max(float(np.std(resid)), _RESID_FLOOR)
        mean = _recursive_predict_tree(model, feature_cols, panel, horizon)
        return {"name": "xgb", "mean": mean, "sigma": sigma, "bic": bic}
    except Exception:
        return None


def _fit_gbr(panel, horizon):
    from sklearn.ensemble import GradientBoostingRegressor

    try:
        X, y = build_supervised(panel)
        if len(y) < _MIN_TRAIN_ROWS:
            return None
        feature_cols = list(X.columns)
        n_est = 200
        max_d = 3
        model = GradientBoostingRegressor(
            n_estimators=n_est,
            max_depth=max_d,
            learning_rate=0.05,
            subsample=0.85,
            random_state=0,
        )
        model.fit(X.values, y.values)
        resid = y.values - model.predict(X.values)
        sse = float(np.sum(resid ** 2))
        n = len(y)
        # Effective k proxy: total leaves across estimators (or n_est * 2^depth).
        try:
            total_leaves = 0
            for tree_arr in model.estimators_:
                t = tree_arr[0].tree_
                total_leaves += int(np.sum(t.children_left == -1))
            k = max(total_leaves, 1)
        except Exception:
            k = int(n_est * max_d)
        bic = _bic_from_sse(sse, n, k)
        sigma = max(float(np.std(resid)), _RESID_FLOOR)
        mean = _recursive_predict_tree(model, feature_cols, panel, horizon)
        return {"name": "gbr", "mean": mean, "sigma": sigma, "bic": bic}
    except Exception:
        return None


# ----------------------- the strategy -----------------------------------

class BMAStrategy(ForecastStrategy):
    """Bayesian Model Averaging across 6 candidate models, BIC-weighted."""

    name = "agent_j_bma"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---------- main BMA path ----------

    def _main(self, panel, horizon):
        candidates = []
        for fitter in (
            _fit_sarima,
            _fit_ridge,
            _fit_elasticnet,
            _fit_lasso,
            _fit_xgb,
            _fit_gbr,
        ):
            try:
                res = fitter(panel, horizon)
            except Exception:
                res = None
            if res is None:
                continue
            mean = np.asarray(res["mean"], dtype=float)
            if mean.shape[0] != horizon or not np.all(np.isfinite(mean)):
                continue
            # Sanity-clip individual model means before weighting.
            mean = np.clip(mean, _MOM_LO_CLIP, _MOM_HI_CLIP)
            res["mean"] = mean
            candidates.append(res)

        if not candidates:
            return self._naive(panel, horizon)

        bics = np.array([c["bic"] for c in candidates], dtype=float)
        weights = _softmax_weights(bics)

        # BMA mean = Σ w_i * μ_i (per horizon)
        means_stack = np.stack([c["mean"] for c in candidates], axis=0)  # (M, H)
        bma_mean = np.sum(weights[:, None] * means_stack, axis=0)        # (H,)

        # Full BMA variance per horizon:
        #   var_h = Σ w_i * (σ_i^2 + (μ_i,h - μ_bma,h)^2)
        sigmas = np.array([c["sigma"] for c in candidates], dtype=float)  # (M,)
        sigmas = np.maximum(sigmas, _RESID_FLOOR)
        within = (sigmas[:, None] ** 2)                                    # (M, 1)
        between = (means_stack - bma_mean[None, :]) ** 2                   # (M, H)
        var_h = np.sum(weights[:, None] * (within + between), axis=0)      # (H,)
        var_h = np.maximum(var_h, _RESID_FLOOR ** 2)
        # Compounding for recursive forecast: variance grows ~linearly with h.
        h_arr = np.arange(1, horizon + 1, dtype=float)
        sd_h = np.sqrt(var_h) * np.sqrt(h_arr)

        bma_mean = np.clip(bma_mean, _MOM_LO_CLIP, _MOM_HI_CLIP)
        spread = _Z80 * sd_h
        return bma_mean, bma_mean - spread, bma_mean + spread

    # ---------- naive fallback ----------

    def _naive(self, panel, horizon):
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
