"""Labor-market depth forecasting (Agent KK).

Round 5 angle: lean on the new labor-side leading indicators we just
added to the panel — initial jobless claims (ICSA), JOLTS job openings
(JTSJOL), and JOLTS quits (JTSQUL). Together these characterize labor
market tightness, which feeds wage growth, which feeds core CPI with
roughly a 3-6 month lag. Quits in particular are a clean wage-pressure
proxy: workers only walk when they have outside offers, and outside
offers come with raises.

Mechanism:
  * Low ICSA (few people losing jobs) => firms holding tight => wages up.
  * High JTSJOL (lots of openings) => firms competing for workers.
  * High JTSQUL (lots of quits) => workers winning that competition.

Strategy outline:
  1. Confirm ICSA / JTSJOL / JTSQUL exist in the panel; if missing fall
     back to a plain build_features matrix.
  2. Augment the standard feature set with labor-specific transforms:
     ICSA MoM/3mo/6mo change (lag1), JOLTS opens/quits MoM/YoY (lag1),
     and a labor-tightness composite z-score.
  3. Direct multi-step Ridge + XGBoost ensemble per horizon (50/50).
  4. 80% bands from per-horizon residual std (z=1.2816).

This stays close to agent_t/agent_b in mechanics — what's new is the
feature signal, not the modeling machinery.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# Labor depth series IDs (must match fred.py).
_ICSA = "ICSA"
_JTSJOL = "JTSJOL"
_JTSQUL = "JTSQUL"


class LaborMarketStrategy(ForecastStrategy):
    name = "agent_kk_labor"

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

    # ------------------------------------------------------------------
    # entry point
    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = self._build_augmented_features(panel)
        y_full = build_target(panel)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                yhat = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), 0.15)
            spread = self._Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # feature construction: standard + labor depth augmentations
    # ------------------------------------------------------------------
    @classmethod
    def _build_augmented_features(cls, panel: pd.DataFrame) -> pd.DataFrame:
        """Standard feature matrix + labor-market specific transforms.

        If any of ICSA/JTSJOL/JTSQUL is absent from the panel we just
        return the base features — graceful degradation rather than
        crashing the race.
        """
        base = build_features(panel)

        labor_extras: dict[str, pd.Series] = {}

        # ---- ICSA (initial jobless claims) ----
        if _ICSA in panel.columns:
            icsa = panel[_ICSA].astype(float)
            labor_extras["ICSA_mom_lag1"] = (
                (icsa / icsa.shift(1) - 1.0) * 100.0
            ).shift(1)
            labor_extras["ICSA_3mo_lag1"] = (
                (icsa / icsa.shift(3) - 1.0) * 100.0
            ).shift(1)
            labor_extras["ICSA_6mo_lag1"] = (
                (icsa / icsa.shift(6) - 1.0) * 100.0
            ).shift(1)

        # ---- JTSJOL (job openings) ----
        if _JTSJOL in panel.columns:
            jol = panel[_JTSJOL].astype(float)
            labor_extras["JTSJOL_mom_lag1"] = (
                (jol / jol.shift(1) - 1.0) * 100.0
            ).shift(1)
            labor_extras["JTSJOL_yoy_lag1"] = (
                (jol / jol.shift(12) - 1.0) * 100.0
            ).shift(1)

        # ---- JTSQUL (quits — wage-growth proxy) ----
        if _JTSQUL in panel.columns:
            qul = panel[_JTSQUL].astype(float)
            labor_extras["JTSQUL_mom_lag1"] = (
                (qul / qul.shift(1) - 1.0) * 100.0
            ).shift(1)
            labor_extras["JTSQUL_yoy_lag1"] = (
                (qul / qul.shift(12) - 1.0) * 100.0
            ).shift(1)

        # ---- Labor tightness composite (z-score sum) ----
        if all(c in panel.columns for c in (_ICSA, _JTSJOL, _JTSQUL)):
            icsa = panel[_ICSA].astype(float)
            jol = panel[_JTSJOL].astype(float)
            qul = panel[_JTSQUL].astype(float)
            # Rolling 5-year z-scores so we don't leak: use only the past.
            tight = (
                -cls._rolling_zscore(icsa)
                + cls._rolling_zscore(jol)
                + cls._rolling_zscore(qul)
            )
            labor_extras["labor_tightness_lag1"] = tight.shift(1)
            labor_extras["labor_tightness_3mo_avg_lag1"] = (
                tight.rolling(3, min_periods=2).mean().shift(1)
            )

        if not labor_extras:
            return base

        extras_df = pd.concat(labor_extras, axis=1)
        # Align on the panel index (extras built from panel.index, base
        # built from panel.index — same DatetimeIndex), join outer to be
        # safe and let downstream dropna handle ragged edges.
        return base.join(extras_df, how="left")

    @staticmethod
    def _rolling_zscore(s: pd.Series, window: int = 60) -> pd.Series:
        """Past-only z-score over `window` months (default 5y).

        min_periods=12 so we get a usable signal early in the sample.
        """
        sf = s.astype(float)
        mu = sf.rolling(window, min_periods=12).mean()
        sd = sf.rolling(window, min_periods=12).std().replace(0.0, np.nan)
        return (sf - mu) / sd

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

        # ---- Ridge ----
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

        # ---- XGBoost ----
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
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        resid_std = float(np.std(resid))
        # Training residuals under-state true OOS error at short h.
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
