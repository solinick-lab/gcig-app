"""Atlanta Fed Sticky CPI specialist.

The Sticky CPI (STICKCPIM157SFRBATL) is a CPI variant that includes only
goods and services with infrequent price changes. Because those prices
change slowly, the series captures inflation PERSISTENCE — once it
moves, it tends to stay moved. That makes it a cleaner signal of
underlying trend inflation than headline CPI, which is contaminated by
volatile food/energy moves and one-off shocks.

This strategy bets that headline forecasts improve when we explicitly
combine:
  (a) Sticky CPI features as a "where is the trend going" anchor; and
  (b) The standard transactional/macro features for transient shocks.

Implementation notes:
  - We add Sticky CPI MoM/3mo/YoY lags AND a sticky-headline divergence
    signal (sticky_yoy - headline_yoy). Divergence flips sign when the
    transitory component dominates, which is informative on its own.
  - Direct multi-step (one model per horizon h) — no error compounding.
  - Per-horizon Ridge (TimeSeriesSplit CV alpha) + XGBoost ensemble.
  - 50/50 blend at h=1, h=2. At h=3 we lean Ridge heavier (60/40),
    because the sticky signal is a long-term anchor and Ridge does a
    better job of leaning on it linearly than XGB tends to.
  - 80% bands from per-horizon training residual std (z=1.2816).
  - Falls back gracefully if Sticky CPI is missing from the panel.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


_STICKY_ID = "STICKCPIM157SFRBATL"


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


class StickyCpiStrategy(ForecastStrategy):
    name = "agent_hh_sticky"

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

        X_full = self._augment_with_sticky(panel, X_base)

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
    # feature engineering: add sticky CPI lags + divergence
    # ------------------------------------------------------------------
    def _augment_with_sticky(
        self, panel: pd.DataFrame, X_base: pd.DataFrame
    ) -> pd.DataFrame:
        """Append sticky-CPI-derived columns to the standard feature matrix.

        If the panel doesn't carry STICKCPIM157SFRBATL we silently fall
        back to the base features — the strategy still runs, it just
        loses its angle.
        """
        if _STICKY_ID not in panel.columns:
            return X_base

        sticky = panel[_STICKY_ID]
        # The Atlanta Fed series is published as an annualized MoM rate,
        # but for our purposes the actual unit doesn't matter — what
        # matters is consistency. We treat it like any other monthly
        # series and lag by 1 to avoid leakage.
        sticky_mom = _mom(sticky).shift(1)
        sticky_3mo = ((sticky / sticky.shift(3) - 1.0) * 100.0).shift(1)
        sticky_yoy = _yoy(sticky).shift(1)

        # Divergence: is headline running hotter or cooler than the
        # underlying trend? When |divergence| is large, headline tends
        # to mean-revert toward sticky over the next several months.
        cpi = panel[TARGET.fred_id]
        headline_yoy = _yoy(cpi).shift(1)
        divergence = (sticky_yoy - headline_yoy).rename("sticky_minus_headline_yoy")

        extras = pd.concat(
            {
                f"{_STICKY_ID}_mom_lag1": sticky_mom,
                f"{_STICKY_ID}_3mo_lag1": sticky_3mo,
                f"{_STICKY_ID}_yoy_lag1": sticky_yoy,
                "sticky_minus_headline_yoy_lag1": divergence,
            },
            axis=1,
        )

        # Some of these columns will already be present in X_base via
        # the FEATURES list (since STICKCPIM157SFRBATL is in there). We
        # don't re-add them — pandas will keep the originals via the
        # left-side suffix on join. Use a clean concat with dedupe.
        X_aug = X_base.join(extras, how="left")
        X_aug = X_aug.loc[:, ~X_aug.columns.duplicated()]
        return X_aug

    # ------------------------------------------------------------------
    # per-horizon fit + ensemble (with horizon-aware blend)
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
            # Horizon-aware blend. Sticky CPI is a long-trend signal, so
            # at h=3 we lean on Ridge (which uses it linearly) more than
            # XGB. At h=1, h=2 we keep the standard 50/50.
            if h >= 3:
                w_ridge = 0.6
            else:
                w_ridge = 0.5
            w_xgb = 1.0 - w_ridge
            yhat = w_ridge * ridge_pred + w_xgb * xgb_pred
            resid = w_ridge * ridge_resid + w_xgb * xgb_resid  # type: ignore[operator]

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
