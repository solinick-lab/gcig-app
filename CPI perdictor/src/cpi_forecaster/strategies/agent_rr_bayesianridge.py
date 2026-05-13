"""Bayesian Ridge / ARD ensemble for direct multi-step CPI forecasting.

When the training set is short (which it always is for monthly CPI),
classic RidgeCV picks alpha by minimizing held-out MSE on a few folds —
noisy in its own right. Bayesian Ridge sidesteps the CV step entirely:
it estimates the regularization strength alpha (precision of the noise)
and lambda (precision of the weights) jointly via empirical Bayes,
maximizing the marginal likelihood. ARDRegression takes the same idea a
step further, learning a separate lambda per coefficient and effectively
pruning irrelevant features (Automatic Relevance Determination).

Per Agent B's pattern, we train one model per horizon h on the
supervised pair (X_T, y_{T+h}) — direct multi-step, no recursive error
compounding. For each horizon we ensemble:

  - BayesianRidge(n_iter=300, alpha_init=1.0, lambda_init=1.0)
    Conjugate-Gaussian regression with empirical-Bayes priors. Returns
    a closed-form posterior std for free via predict(return_std=True).
  - ARDRegression(n_iter=300)
    Same backbone, per-feature precision priors, sparsifies the weight
    vector when features are redundant.

Predictions are equal-weighted. The 80% interval uses the posterior std
returned by BayesianRidge directly with z=1.2816 (one-sided), floored at
0.10 to avoid pathologically tight intervals at short h.
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


class BayesianRidgeStrategy(ForecastStrategy):
    name = "agent_rr_bayesianridge"

    _BR_PARAMS = dict(
        n_iter=300,
        alpha_init=1.0,
        lambda_init=1.0,
    )
    _ARD_PARAMS = dict(
        n_iter=300,
    )
    _Z80 = 1.2816  # one-sided z for 80% interval
    _STD_FLOOR = 0.10

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
                yhat, post_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat = self._last_observed_mom(y_full)
                post_std = max(self._empirical_mom_std(y_full), 0.15)

            spread = self._Z80 * post_std
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
        """Train BayesianRidge + ARDRegression on (X_T, y_{T+h})."""
        from sklearn.linear_model import ARDRegression, BayesianRidge
        from sklearn.preprocessing import StandardScaler

        # Direct multi-step: shift y back by h so y_target.loc[T] is the
        # MoM at month T+h. Inner-join keeps only rows where both X_T
        # and y_{T+h} are observed.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            post_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, post_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Both Bayesian linear regressors expect standardized inputs to
        # keep the per-feature lambda priors comparable.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        preds: list[float] = []
        post_stds: list[float] = []

        # ---- BayesianRidge (empirical-Bayes ridge with closed-form posterior std) ----
        try:
            br = BayesianRidge(**self._BR_PARAMS).fit(Xs, y)
            br_mean, br_std = br.predict(x_live_s, return_std=True)
            preds.append(float(br_mean[0]))
            post_stds.append(float(br_std[0]))
        except Exception:
            pass

        # ---- ARDRegression (per-feature precision priors / auto-pruning) ----
        try:
            ard = ARDRegression(**self._ARD_PARAMS).fit(Xs, y)
            ard_pred = ard.predict(x_live_s)
            preds.append(float(ard_pred[0]))
        except Exception:
            pass

        if not preds:
            yhat = self._last_observed_mom(y_full)
            post_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, post_std

        # Equal-weight average of the two members (or just one if ARD failed).
        yhat = float(np.mean(preds))

        # 80% band: pull the posterior std straight from BayesianRidge —
        # that's the whole point of going Bayesian. If BR itself failed,
        # fall back to empirical MoM std as a safety net.
        if post_stds:
            post_std = float(np.mean(post_stds))
        else:
            post_std = max(self._empirical_mom_std(y_full), 0.15)
        post_std = max(post_std, self._STD_FLOOR)
        return yhat, post_std

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
