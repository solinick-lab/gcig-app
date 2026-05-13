"""Direct multi-step forecasting.

The baseline `RidgeForecaster` (and the recursive XGB) trains a single
one-step model and iterates by feeding its own predictions back into the
CPI lag columns. That works, but it compounds error: the input features
the model sees at h=2,3,... are themselves noisy estimates, not real
data, and the bias/variance accumulate.

This strategy avoids that entirely. For each horizon h in 1..H we train
a SEPARATE model on the supervised pair (X_T, y_{T+h}), where X_T is
exactly the same feature matrix produced by `build_features` and
y_{T+h} is `build_target(panel).shift(-h)`. Each model directly maps
"features known at month T" to "MoM at month T+h", so prediction is a
single forward pass per horizon — no chaining, no error compounding.

To keep it robust we ensemble a Ridge (with TimeSeriesSplit alpha CV)
and an XGBoost regressor per horizon. Both are quick to fit on this
panel size; total runtime per cut is comfortably in the few-second
range. Forecast intervals come from the per-horizon training residual
std (z=1.2816 for 80%), so they widen naturally for harder horizons
without the artificial sqrt(h) scaling that recursive models lean on.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


# Suppress the noisy convergence / future warnings from sklearn + xgb;
# they don't affect correctness and we don't want them in the race log.
warnings.filterwarnings("ignore")


class DirectMultiStepStrategy(ForecastStrategy):
    name = "agent_b_direct"

    # Tuned for the small monthly panel: small grid, light XGB.
    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)
    _XGB_PARAMS = dict(
        n_estimators=300,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_lambda=1.0,
        objective="reg:squarederror",
        n_jobs=1,
        verbosity=0,
        random_state=0,
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

        # The "live" feature row used for every horizon's prediction:
        # the most recent row at the cut date, with a tiny ffill to
        # patch any ragged-edge NaNs in macro covariates (matches the
        # baseline ridge convention).
        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                # Per-horizon fallback: last observed MoM with a wide-ish
                # interval. Keeps the strategy from crashing the race.
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
        """Train ridge + xgb on (X_T, y_{T+h}) and return (mean, resid_std)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        # Shift y back by -h so y_target.loc[T] == MoM at T+h. Then align
        # with X and drop rows that have any NaN in features or target.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            # Not enough history to bother — fall back to last MoM.
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # ---- Ridge with TimeSeriesSplit-CV alpha ----
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
        ridge_pred = float(ridge.predict(x_live_s)[0])
        ridge_resid = y - ridge.predict(Xs)

        # ---- XGBoost (best-effort; if unavailable, just use ridge) ----
        xgb_pred: float | None = None
        xgb_resid: np.ndarray | None = None
        try:
            from xgboost import XGBRegressor

            model = XGBRegressor(**self._XGB_PARAMS).fit(X, y)
            xgb_pred = float(model.predict(x_live)[0])
            xgb_resid = y - model.predict(X)
        except Exception:
            xgb_pred = None
            xgb_resid = None

        if xgb_pred is None:
            yhat = ridge_pred
            resid = ridge_resid
        else:
            # 50/50 average. Ridge anchors the scale; XGB picks up
            # nonlinearities/interactions the linear model misses.
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        resid_std = float(np.std(resid))
        # Floor the spread: training residuals understate true OOS error,
        # especially at short h where the model fits very tightly.
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
        # Use the last ~5 years as a reasonable scale estimate.
        return float(s.tail(60).std())

    # ------------------------------------------------------------------
    # whole-strategy fallback if everything else blows up
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
