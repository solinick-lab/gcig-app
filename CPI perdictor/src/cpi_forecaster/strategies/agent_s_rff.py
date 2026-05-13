"""Agent S: Random Fourier Features (RFF) + Ridge.

Approximates an RBF kernel via random features (sklearn's RBFSampler /
Nystroem), then fits a RidgeCV on the expanded feature space. This gives
us a kernel-SVR-style nonlinearity at linear-model cost — usually a
sweet spot on small monthly panels where pure linear models underfit
interactions and pure trees overfit / chase noise.

Pipeline per horizon:
    StandardScaler -> RBFSampler(n_components=200, gamma=g) -> RidgeCV

We pick `gamma` from a small grid via TimeSeriesSplit-CV on the training
slice (RMSE), and we benchmark RBFSampler vs Nystroem head-to-head and
take whichever has lower CV RMSE for that horizon. Multi-step is direct:
one independent model per horizon h in 1..H. Bands come from the
training residual std with a sqrt(h) widening (z=1.2816 for 80%).
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class RFFStrategy(ForecastStrategy):
    name = "agent_s_rff"

    _GAMMAS = (0.01, 0.05, 0.1, 0.5)
    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)
    _N_COMPONENTS = 200
    _Z80 = 1.2816  # one-sided z for 80% interval
    _SEED = 42

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = build_features(panel)
        y_full = build_target(panel)
        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), 0.15)

            spread = self._Z80 * resid_std * np.sqrt(h)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon fit (RFF + Ridge, with RBFSampler vs Nystroem bench)
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        from sklearn.kernel_approximation import Nystroem, RBFSampler
        from sklearn.linear_model import RidgeCV
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.preprocessing import StandardScaler

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Scale once on the full training slice; all kernel approximators
        # see standardized inputs (gamma is interpretable in unit space).
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        n_splits = min(5, max(2, len(df) // 60))
        tscv = TimeSeriesSplit(n_splits=n_splits)

        # Nystroem n_components capped by smallest training fold size,
        # otherwise sklearn raises. Be generous but safe.
        n_train_min = max(2, (len(df) // (n_splits + 1)) * 1)
        nystroem_n = int(min(self._N_COMPONENTS, max(20, n_train_min - 1)))

        best = None  # (cv_rmse, kind, gamma)
        for gamma in self._GAMMAS:
            for kind in ("rbf", "nystroem"):
                try:
                    rmse = self._cv_rmse(
                        Xs, y, tscv, kind=kind, gamma=gamma, nystroem_n=nystroem_n
                    )
                except Exception:
                    continue
                if not np.isfinite(rmse):
                    continue
                if best is None or rmse < best[0]:
                    best = (rmse, kind, gamma)

        if best is None:
            # Pure ridge fallback if every kernel approx blew up.
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
            yhat = float(ridge.predict(x_live_s)[0])
            resid = y - ridge.predict(Xs)
            return yhat, max(float(np.std(resid)), 0.10)

        _, kind, gamma = best

        # Refit the winning approximator on the full training slice.
        if kind == "rbf":
            sampler = RBFSampler(
                n_components=self._N_COMPONENTS,
                gamma=gamma,
                random_state=self._SEED,
            ).fit(Xs)
        else:
            sampler = Nystroem(
                kernel="rbf",
                gamma=gamma,
                n_components=nystroem_n,
                random_state=self._SEED,
            ).fit(Xs)

        Z = sampler.transform(Xs)
        z_live = sampler.transform(x_live_s)

        try:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Z, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Z, y)

        yhat = float(ridge.predict(z_live)[0])
        resid = y - ridge.predict(Z)
        resid_std = max(float(np.std(resid)), 0.10)
        return yhat, resid_std

    # ------------------------------------------------------------------
    # CV helpers
    # ------------------------------------------------------------------
    def _cv_rmse(
        self,
        Xs: np.ndarray,
        y: np.ndarray,
        tscv,
        kind: str,
        gamma: float,
        nystroem_n: int,
    ) -> float:
        from sklearn.kernel_approximation import Nystroem, RBFSampler
        from sklearn.linear_model import RidgeCV

        errs: list[float] = []
        for tr_idx, va_idx in tscv.split(Xs):
            X_tr, X_va = Xs[tr_idx], Xs[va_idx]
            y_tr, y_va = y[tr_idx], y[va_idx]

            if kind == "rbf":
                sampler = RBFSampler(
                    n_components=self._N_COMPONENTS,
                    gamma=gamma,
                    random_state=self._SEED,
                ).fit(X_tr)
            else:
                # Nystroem fold-size cap: must be < n_samples in this fold.
                n_comp = int(min(nystroem_n, max(10, len(X_tr) - 1)))
                sampler = Nystroem(
                    kernel="rbf",
                    gamma=gamma,
                    n_components=n_comp,
                    random_state=self._SEED,
                ).fit(X_tr)

            Z_tr = sampler.transform(X_tr)
            Z_va = sampler.transform(X_va)
            try:
                model = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Z_tr, y_tr)
            except Exception:
                continue
            pred = model.predict(Z_va)
            errs.append(float(np.sqrt(np.mean((y_va - pred) ** 2))))

        if not errs:
            return float("inf")
        return float(np.mean(errs))

    # ------------------------------------------------------------------
    # misc helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    @staticmethod
    def _last_observed_mom(y_full: pd.Series) -> float:
        s = y_full.dropna()
        if s.empty:
            return 0.0
        return float(s.iloc[-1])

    @staticmethod
    def _empirical_mom_std(y_full: pd.Series) -> float:
        s = y_full.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    # ------------------------------------------------------------------
    # whole-strategy fallback
    # ------------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = self._last_observed_mom(y)
            sd = max(self._empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
