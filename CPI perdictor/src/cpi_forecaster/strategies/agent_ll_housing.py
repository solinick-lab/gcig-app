"""Housing leading-indicator forecasting (Agent LL).

Shelter is roughly a third of CPI and the slowest-moving component —
its OER and rent-of-primary-residence subindexes track new-lease market
rents with a notoriously long lag. The leading market signal isn't
rents themselves (those bleed into shelter quickly) but the upstream
housing-supply pipeline: starts (HOUST) and permits (PERMIT). Their
year-over-year movements lead the shelter-CPI passthrough by 12 to 18
months, with permits leading starts by a quarter or two.

This strategy emphasizes that very-long-lag relationship rather than
the typical 1-3 month lag pattern build_features uses. We bolt extra
features onto build_features that explicitly look 12, 18, and 24
months back at HOUST and PERMIT YoY changes, plus a HOUST/PERMIT ratio
(a proxy for completion vs. authorization rates) and a 12-month moving
average YoY change for HOUST (smoother trend signal that strips short
construction-cycle noise). Together they let the model exploit the
shelter-passthrough delay directly.

Per-horizon Ridge + XGB ensemble in MoM space (direct multi-step), 80%
bands from training residuals.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class HousingLeadingStrategy(ForecastStrategy):
    name = "agent_ll_housing"

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
        X_base = build_features(panel)
        X_housing = self._build_housing_features(panel)
        # Augment the standard feature matrix with the long-lag housing
        # features. Inner-join keeps rows where both are populated.
        X_full = X_base.join(X_housing, how="left")
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
    # housing-specific long-lag features
    # ------------------------------------------------------------------
    @staticmethod
    def _build_housing_features(panel: pd.DataFrame) -> pd.DataFrame:
        """Long-lag housing features capturing the shelter-CPI passthrough.

        If HOUST or PERMIT are missing from the panel we silently return
        an empty frame so the strategy still trains on the base feature
        set.
        """
        cols: dict[str, pd.Series] = {}
        idx = panel.index

        has_houst = "HOUST" in panel.columns
        has_permit = "PERMIT" in panel.columns

        if has_houst:
            houst = panel["HOUST"].astype(float)
            houst_yoy = (houst / houst.shift(12) - 1.0) * 100.0
            # Lag-12/18/24 of YoY: information available at month T about
            # the housing pipeline 12-24 months prior, which is when the
            # shelter-CPI passthrough is strongest.
            cols["HOUST_yoy_lag12"] = houst_yoy.shift(12)
            cols["HOUST_yoy_lag18"] = houst_yoy.shift(18)
            cols["HOUST_yoy_lag24"] = houst_yoy.shift(24)
            # 12-month MA of HOUST level, then YoY of that smoothed series,
            # then lag 12. Strips short-cycle noise in starts so the
            # signal is the multi-quarter trend.
            houst_ma12 = houst.rolling(window=12, min_periods=6).mean()
            houst_ma12_yoy = (houst_ma12 / houst_ma12.shift(12) - 1.0) * 100.0
            cols["HOUST_ma12_yoy_lag12"] = houst_ma12_yoy.shift(12)

        if has_permit:
            permit = panel["PERMIT"].astype(float)
            permit_yoy = (permit / permit.shift(12) - 1.0) * 100.0
            cols["PERMIT_yoy_lag12"] = permit_yoy.shift(12)
            cols["PERMIT_yoy_lag18"] = permit_yoy.shift(18)

        if has_houst and has_permit:
            houst = panel["HOUST"].astype(float)
            permit = panel["PERMIT"].astype(float)
            # Construction completion proxy: HOUST/PERMIT. When this
            # ratio falls, builders have lots of authorized projects
            # they haven't broken ground on yet — a forward signal of
            # supply and therefore future shelter inflation.
            ratio = houst / permit.replace(0.0, np.nan)
            cols["HOUST_PERMIT_ratio_lag1"] = ratio.shift(1)
            cols["HOUST_PERMIT_ratio_lag12"] = ratio.shift(12)

        if not cols:
            return pd.DataFrame(index=idx)
        return pd.concat(cols, axis=1)

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
        """Train ridge + xgb on (X_T, y_{T+h}); return (mean, resid_std)."""
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
        x_live = live_row.reindex(feature_cols).values.astype(float).reshape(1, -1)

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

        # ---- XGBoost (optional) ----
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
        # Slightly more generous ffill: housing features at lag 12/18/24
        # are sturdy and we don't want a single ragged month to wipe them.
        feats = feats.ffill(limit=3)
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
