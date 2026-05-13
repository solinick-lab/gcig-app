"""Capacity utilization + activity gap forecasting (Agent PP).

When factories run hot, prices rise. Capacity Utilization (TCU) measures
how much of the economy's productive capacity is actually in use; once
it climbs past roughly 80%, bottlenecks start forming — input shortages,
overtime premiums, deferred maintenance — and producers pass costs
through. The gap between current utilization and that ~80% threshold is
a classic supply-side inflation pressure gauge that monetary policy
historically tracks alongside slack measures like the unemployment gap.

Industrial Production (INDPRO) on its own says how much output is being
produced; TCU contextualizes whether that output is comfortable or
straining. Their interaction is what the model needs: high INDPRO MoM
when TCU is already elevated indicates the economy is pushing further
into bottleneck territory, while the same INDPRO move at low utilization
just means slack is being absorbed without inflation pressure.

Features layered on top of build_features:
  - TCU level (lag 1) — the capacity gauge itself.
  - TCU MoM and 3-month change — direction of pressure.
  - TCU - 80 — explicit output gap proxy; positive = overheating.
  - INDPRO MoM x TCU level — bottleneck interaction term.
  - 12-month z-score of TCU — recent regime relative to its own history.

Direct multi-step Ridge + XGB ensemble in MoM space (50/50), 80% bands
from training residuals at z = 1.2816. Falls back to standard features
if TCU is missing, and to a naive last-MoM forecast if anything else
goes wrong.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class CapacityStrategy(ForecastStrategy):
    name = "agent_pp_capacity"

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
    _CAPACITY_THRESHOLD = 80.0  # bottleneck threshold for TCU (%)

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
        X_cap = self._build_capacity_features(panel)
        # Left-join keeps rows that have at least the base features; the
        # capacity columns may be absent if TCU is missing entirely, in
        # which case the strategy degrades gracefully to the base set.
        X_full = X_base.join(X_cap, how="left") if not X_cap.empty else X_base
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
    # capacity-specific features
    # ------------------------------------------------------------------
    def _build_capacity_features(self, panel: pd.DataFrame) -> pd.DataFrame:
        """TCU level, gaps, dynamics, and INDPRO interaction.

        Returns an empty frame if TCU is absent so the rest of the
        pipeline can still run on the base feature set.
        """
        cols: dict[str, pd.Series] = {}
        idx = panel.index

        if "TCU" not in panel.columns:
            return pd.DataFrame(index=idx)

        tcu = panel["TCU"].astype(float)

        # Plain level lag 1 — the gauge.
        cols["TCU_level_lag1"] = tcu.shift(1)

        # Month-over-month change in TCU (already in % units, so a simple
        # difference is the natural "change in utilization" signal).
        tcu_mom = tcu.diff()
        cols["TCU_mom_lag1"] = tcu_mom.shift(1)

        # 3-month change — smoother direction-of-pressure measure.
        cols["TCU_3mo_lag1"] = (tcu - tcu.shift(3)).shift(1)

        # Output gap proxy: TCU minus the 80% bottleneck threshold.
        # Positive values indicate overheating capacity; negative ones
        # indicate slack. Lagged so it reflects information available at
        # the time we'd produce a forecast.
        cols["TCU_gap80_lag1"] = (tcu - self._CAPACITY_THRESHOLD).shift(1)

        # 12-month z-score of TCU — places current utilization in the
        # context of its own recent regime, which catches "high relative
        # to last year" even when the absolute level isn't extreme.
        roll_mean = tcu.rolling(window=12, min_periods=6).mean()
        roll_std = tcu.rolling(window=12, min_periods=6).std()
        # Guard against the (very rare) zero-variance window: replace with
        # NaN so the row is dropped rather than producing inf.
        z = (tcu - roll_mean) / roll_std.replace(0.0, np.nan)
        cols["TCU_z12_lag1"] = z.shift(1)

        # INDPRO MoM x TCU level — interaction term. High industrial
        # production growth at already-high utilization is the classic
        # bottleneck signature; the same growth at low utilization just
        # absorbs slack. The product captures that nonlinearity in a
        # form a linear model can use directly.
        if "INDPRO" in panel.columns:
            indpro = panel["INDPRO"].astype(float)
            indpro_mom = (indpro / indpro.shift(1) - 1.0) * 100.0
            cols["INDPRO_TCU_interaction_lag1"] = (indpro_mom * tcu).shift(1)

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
        # Modest ffill so a single ragged month doesn't wipe out the
        # capacity columns (TCU prints monthly but can lag).
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
