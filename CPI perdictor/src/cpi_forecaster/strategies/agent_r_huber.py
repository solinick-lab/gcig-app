"""Huber-loss gradient boosting for direct multi-step CPI forecasting.

Quantile regression uses L1-style loss; ordinary GBR uses L2. Huber loss
is the middle ground — quadratic for small errors, linear for large
ones. More robust than L2, more efficient than L1 in the presence of
the occasional outsized monthly print (think 2008, 2020-21, 2022-23).

Per Agent B's pattern, we train one model per horizon h on the
supervised pair (X_T, y_{T+h}) — direct multi-step, no recursive error
compounding. For each horizon we ensemble:

  - GradientBoostingRegressor(loss='huber', alpha=0.9, ...)
    Tree-based boosted ensemble with Huber loss. Captures the
    nonlinearities a Ridge can't (e.g. shelter inertia kicking in only
    after a YoY threshold).
  - HuberRegressor (sklearn linear-in-features Huber).
    A robust linear anchor — cheap and stable.
  - RidgeCV with TimeSeriesSplit alpha selection.
    Standard L2 linear baseline, picks the regularization strength via
    expanding-window CV.

The three predictions are averaged with equal weights. 80% bands come
from the per-horizon training-residual std with z=1.2816 (one-sided),
floored at 0.10 to avoid pathologically tight intervals at short h.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


# Quiet the noisy convergence / future warnings — they don't affect
# correctness and we don't want them spamming the race log.
warnings.filterwarnings("ignore")


class HuberStrategy(ForecastStrategy):
    name = "agent_r_huber"

    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)
    _GBR_PARAMS = dict(
        loss="huber",
        alpha=0.9,
        n_estimators=400,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        random_state=0,
    )
    _HUBER_PARAMS = dict(
        epsilon=1.35,  # sklearn default; standard Huber threshold
        alpha=1e-3,
        max_iter=200,
    )
    _Z80 = 1.2816  # one-sided z for 80% interval

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

            spread = self._Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon fit + ensemble
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Train ridge + GBR(huber) + HuberRegressor on (X_T, y_{T+h})."""
        from sklearn.ensemble import GradientBoostingRegressor
        from sklearn.linear_model import HuberRegressor, RidgeCV
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.preprocessing import StandardScaler

        # Direct multi-step: shift y back by h so y_target.loc[T] is the
        # MoM at month T+h. Inner-join keeps only rows where both X_T
        # and y_{T+h} are observed.
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

        # Linear models want standardized inputs; the GBR is invariant.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        preds: list[float] = []
        resids: list[np.ndarray] = []

        # ---- Ridge with TimeSeriesSplit-CV alpha ----
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
        preds.append(float(ridge.predict(x_live_s)[0]))
        resids.append(y - ridge.predict(Xs))

        # ---- GradientBoostingRegressor with Huber loss ----
        try:
            gbr = GradientBoostingRegressor(**self._GBR_PARAMS).fit(X, y)
            preds.append(float(gbr.predict(x_live)[0]))
            resids.append(y - gbr.predict(X))
        except Exception:
            pass

        # ---- HuberRegressor (robust linear) ----
        try:
            huber = HuberRegressor(**self._HUBER_PARAMS).fit(Xs, y)
            preds.append(float(huber.predict(x_live_s)[0]))
            resids.append(y - huber.predict(Xs))
        except Exception:
            pass

        # Equal-weight average. With three members we lean on Ridge for
        # scale anchoring, the boosted Huber for nonlinearities, and the
        # linear Huber for tail-robust slope estimation.
        yhat = float(np.mean(preds))
        # Average the per-model residual vectors before taking std —
        # mirrors agent_b_direct's convention so spreads are comparable.
        resid_avg = np.mean(np.stack(resids, axis=0), axis=0)
        resid_std = float(np.std(resid_avg))
        # Floor: in-sample residuals understate true OOS error,
        # especially at short h where models fit very tightly.
        resid_std = max(resid_std, 0.10)
        return yhat, resid_std

    # ------------------------------------------------------------------
    # helpers
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
