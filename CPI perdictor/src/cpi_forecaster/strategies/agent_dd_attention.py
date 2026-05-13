"""Agent DD — Lightweight attention / linear-attention forecaster.

A "self-attention" mechanism implemented in pure numpy + sklearn (no
torch/keras). For each forecast cut we look back over the last K=24
months of training rows, compute Gaussian-kernel similarity between the
current macro state x_now and each past state x_i, softmax to get
attention weights w_i, and predict y_hat = sum(w_i * y_i) — i.e. a
soft-Gaussian KNN where the bandwidth sigma is tuned by TimeSeriesSplit
cross-validation rather than fixed.

The attention prediction is then ensembled 50/50 with a Ridge model on
the same features so we keep a stable linear macro anchor when the
attention window is sparse or all-similar.

Conceptually this is a smarter version of agent_o_analog: instead of
hard top-K with distance weights and a fixed K, every recent month gets
a soft weight whose decay rate (sigma) is learned. Direct multi-step
per horizon. 80% bands come from training residual std.

Per the race contract, fit_and_predict NEVER raises — wrapped in nested
try/except with a Ridge-only fallback and ultimately a persistence
fallback.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ---- constants ----
_K_WINDOW = 24            # attention window (last K months of training data)
_BLEND_W = 0.5            # 0.5 = 50/50 attention + Ridge
_Z80 = 1.2816             # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36

# Sigma grid for bandwidth tuning. These are in standardized-feature
# distance units (Euclidean over scaled X). Wider than they look because
# the standardized squared distance accumulates across ~30+ features.
_SIGMA_GRID = np.array([1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0])


def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    feats = X_full.copy()
    feats = feats.ffill(limit=2)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _last_observed_mom(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())


def _attention_predict(
    X_train: np.ndarray,
    y_train: np.ndarray,
    x_query: np.ndarray,
    sigma: float,
    k_window: int,
) -> float:
    """Soft-Gaussian-KNN over the last k_window training rows.

    w_i = softmax(-||x_query - x_i||^2 / (2*sigma^2))
    y_hat = sum_i w_i * y_i
    """
    if len(y_train) == 0:
        return 0.0
    k = min(k_window, len(y_train))
    Xw = X_train[-k:]
    yw = y_train[-k:]
    diffs = Xw - x_query.reshape(1, -1)
    d2 = np.sum(diffs * diffs, axis=1)
    # Numerical-stable softmax over -d2 / (2 sigma^2).
    logits = -d2 / max(2.0 * sigma * sigma, 1e-9)
    logits -= np.max(logits)
    w = np.exp(logits)
    s = float(np.sum(w))
    if not np.isfinite(s) or s <= 0.0:
        return float(np.mean(yw))
    w = w / s
    return float(np.sum(w * yw))


def _tune_sigma(
    Xs: np.ndarray,
    y: np.ndarray,
    sigma_grid: np.ndarray,
    k_window: int,
) -> float:
    """Pick sigma minimizing TimeSeriesSplit-CV MSE of the attention prediction."""
    from sklearn.model_selection import TimeSeriesSplit

    n = len(y)
    if n < 12:
        return float(np.median(sigma_grid))

    n_splits = min(5, max(2, n // 24))
    try:
        tscv = TimeSeriesSplit(n_splits=n_splits)
        splits = list(tscv.split(Xs))
    except Exception:
        return float(np.median(sigma_grid))

    best_sigma = float(sigma_grid[len(sigma_grid) // 2])
    best_mse = np.inf
    for sigma in sigma_grid:
        errs = []
        for tr_idx, va_idx in splits:
            if len(tr_idx) < 4 or len(va_idx) < 1:
                continue
            X_tr = Xs[tr_idx]
            y_tr = y[tr_idx]
            X_va = Xs[va_idx]
            y_va = y[va_idx]
            for j in range(len(va_idx)):
                yhat = _attention_predict(
                    X_tr, y_tr, X_va[j], sigma, k_window
                )
                errs.append((yhat - y_va[j]) ** 2)
        if not errs:
            continue
        mse = float(np.mean(errs))
        if mse < best_mse:
            best_mse = mse
            best_sigma = float(sigma)
    return best_sigma


class AttentionStrategy(ForecastStrategy):
    """Soft-Gaussian-KNN attention + Ridge ensemble (pure numpy/sklearn)."""

    name = "agent_dd_attention"

    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = build_features(panel)
        y_full = build_target(panel)

        if X_full.empty or y_full.dropna().empty:
            return self._naive(panel, horizon)

        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, lo, hi = self._predict_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                yhat = _last_observed_mom(y_full)
                std = max(_empirical_mom_std(y_full), 0.15)
                spread = _Z80 * std
                lo = yhat - spread
                hi = yhat + spread

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            lo = float(np.clip(lo, _MOM_LO_CLIP - 0.5, _MOM_HI_CLIP + 0.5))
            hi = float(np.clip(hi, _MOM_LO_CLIP - 0.5, _MOM_HI_CLIP + 0.5))
            lo = min(lo, yhat - _RESID_FLOOR * _Z80 * 0.5)
            hi = max(hi, yhat + _RESID_FLOOR * _Z80 * 0.5)

            means[i] = yhat
            los[i] = lo
            his[i] = hi

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon attention + ridge ensemble
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train Attention + Ridge on (X_T, y_{T+h}) and return (yhat, lo80, hi80)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        # Build (X_T, y_{T+h}) supervised pair (direct multi-step).
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            yhat = _last_observed_mom(y_full)
            std = max(_empirical_mom_std(y_full), 0.15)
            spread = _Z80 * std
            return yhat, yhat - spread, yhat + spread

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Scale on TRAINING data only.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)[0]

        # ---- Attention: tune sigma via TS-CV, then predict ----
        try:
            sigma = _tune_sigma(Xs, y, _SIGMA_GRID, _K_WINDOW)
        except Exception:
            sigma = float(np.median(_SIGMA_GRID))

        try:
            attn_pred = _attention_predict(Xs, y, x_live_s, sigma, _K_WINDOW)
        except Exception:
            attn_pred = float(np.nan)

        # ---- Ridge anchor ----
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
        ridge_pred = float(ridge.predict(x_live_s.reshape(1, -1))[0])

        # ---- 50/50 blend ----
        if not np.isfinite(attn_pred):
            yhat = ridge_pred
        elif not np.isfinite(ridge_pred):
            yhat = attn_pred
        else:
            yhat = _BLEND_W * attn_pred + (1.0 - _BLEND_W) * ridge_pred

        # ---- 80% interval: training residual std of the blend ----
        try:
            ridge_resid = y - ridge.predict(Xs)
            std = float(np.std(ridge_resid))
        except Exception:
            std = _empirical_mom_std(y_full)
        std = max(std, _RESID_FLOOR)
        spread = _Z80 * std
        lo = yhat - spread
        hi = yhat + spread

        return yhat, lo, hi

    # ------------------------------------------------------------------
    # whole-strategy fallback
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = _last_observed_mom(y)
            sd = max(_empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
