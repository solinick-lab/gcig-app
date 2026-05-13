"""Subcomponents-as-features direct multi-step strategy.

Hypothesis: CPIUFDSL (Food), CPIENGSL (Energy), and CPILFESL (Core) are
direct same-frequency observations of the things that drive headline CPI.
Past hierarchical agents tried to forecast each subcomponent separately
and aggregate them — that lost in earlier rounds because the aggregation
amplified each component's error and the BLS weights drift.

This strategy keeps the headline-level direct multi-step pipeline from
agent_b_direct, but enriches the feature matrix with lagged MoM/YoY of
the three subcomponents. Ridge + XGBoost can then learn the local
headline ↔ subcomponent dynamics directly (e.g. "Core moved up before
Food this month → headline lags by one"), without committing to a fixed
aggregation weight scheme.

Failure-mode handling:
  - If any of the three subcomponent series are missing from the panel
    (older snapshots, partial fetches), we skip the augmentation and
    fall back to the base feature set so we still produce a forecast.
  - All other failure paths inherit from the agent_b style: per-horizon
    fallback to last observed MoM, whole-strategy fallback to a flat
    forecast with a residual-scaled band.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# Subcomponent series we want as additional features. Hard-coded rather
# than imported from fred.SUBCOMPONENTS so the missing-column fallback
# below stays explicit and easy to audit.
_SUBCOMP_FOOD = "CPIUFDSL"
_SUBCOMP_ENERGY = "CPIENGSL"
_SUBCOMP_CORE = "CPILFESL"
_REQUIRED_SUBCOMPS = (_SUBCOMP_FOOD, _SUBCOMP_ENERGY, _SUBCOMP_CORE)


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _build_subcomp_features(panel: pd.DataFrame) -> pd.DataFrame | None:
    """Lagged MoM / YoY columns for the three CPI subcomponents.

    Returns None if any required subcomponent is missing from the panel,
    which signals the caller to fall back to the base feature set.
    """
    missing = [c for c in _REQUIRED_SUBCOMPS if c not in panel.columns]
    if missing:
        return None

    rows: dict[str, pd.Series] = {}

    food = panel[_SUBCOMP_FOOD]
    rows["food_mom_lag1"] = _mom(food).shift(1)
    rows["food_mom_lag2"] = _mom(food).shift(2)
    rows["food_mom_lag3"] = _mom(food).shift(3)
    rows["food_mom_lag12"] = _mom(food).shift(12)
    rows["food_yoy_lag1"] = _yoy(food).shift(1)

    energy = panel[_SUBCOMP_ENERGY]
    rows["energy_mom_lag1"] = _mom(energy).shift(1)
    rows["energy_mom_lag2"] = _mom(energy).shift(2)
    rows["energy_mom_lag3"] = _mom(energy).shift(3)
    rows["energy_yoy_lag1"] = _yoy(energy).shift(1)

    core = panel[_SUBCOMP_CORE]
    rows["core_mom_lag1"] = _mom(core).shift(1)
    rows["core_mom_lag2"] = _mom(core).shift(2)
    rows["core_mom_lag3"] = _mom(core).shift(3)
    rows["core_yoy_lag1"] = _yoy(core).shift(1)

    return pd.concat(rows, axis=1)


class SubcomponentFeaturesStrategy(ForecastStrategy):
    name = "agent_u_subcompfeat"

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
    _Z80 = 1.2816

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
        X_base = build_features(panel)
        y_full = build_target(panel)

        # Augment with subcomponent features when available; skip
        # silently otherwise (older panels, partial fetches).
        sub_feats = _build_subcomp_features(panel)
        if sub_feats is not None:
            X_full = X_base.join(sub_feats, how="left")
        else:
            X_full = X_base

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
