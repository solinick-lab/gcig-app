"""Trimmed-mean CPI as the modeling target (Agent UU).

The Cleveland Fed's trimmed-mean CPI (TRMMEANCPIM158SFRBCLE) drops the
most extreme price changes each month — by construction it has a much
higher signal-to-noise ratio than headline CPI, which is dominated by
volatile food & energy moves and one-off basket components. Models
fitted to noisy MoM headline targets spend a lot of their capacity
chasing month-specific shocks; models fitted to trimmed-mean targets
get to learn the underlying inflation dynamic.

This strategy:

1. Forecasts the trimmed-mean MoM directly (Ridge + XGBoost ensemble,
   one model per horizon — direct multi-step).
2. Adds the historical mean of (headline_mom − trimmed_mom) over the
   last 24 months back onto each prediction. This "wedge" captures
   the typical contribution of the trimmed tails — e.g. when energy
   has been systematically running hot, headline runs above trimmed
   and the wedge is positive.
3. Combines the trimmed-model residual std with the wedge variance
   (added in quadrature) for the 80% bands.

If TRMMEANCPIM158SFRBCLE is missing from the panel (older snapshots
may lack it), falls back to the standard direct-MoM approach so the
strategy degrades gracefully.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


TRIMMED_ID = "TRMMEANCPIM158SFRBCLE"


class TrimmedTargetStrategy(ForecastStrategy):
    name = "agent_uu_trimtarget"

    _RIDGE_ALPHAS = np.logspace(-2, 4, 19)
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
    _WEDGE_WINDOW = 24  # months of history used to estimate the wedge

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
        cpi = panel[TARGET.fred_id].astype(float).dropna()
        if len(cpi) < 36:
            return self._fallback(panel, horizon)

        # Trimmed-mean CPI must be present; otherwise fall back.
        if TRIMMED_ID not in panel.columns:
            return self._fallback(panel, horizon)
        trimmed_level = panel[TRIMMED_ID].astype(float).dropna()
        if len(trimmed_level) < 36:
            return self._fallback(panel, horizon)

        # ----- Targets -----
        # Trimmed MoM (log %): the model's actual learning target.
        trimmed_mom = (
            np.log(trimmed_level) - np.log(trimmed_level.shift(1))
        ) * 100.0
        trimmed_mom = trimmed_mom.rename("trimmed_mom_target")

        # Headline MoM (log %): used for the wedge calculation only.
        headline_mom = build_target(panel)

        # ----- Wedge: headline_mom - trimmed_mom over last 24 months -----
        # Aligned on dates where both exist. We use the 24 most recent
        # months ending at the cut date (i.e. the latest available value
        # in the panel — which is usually one month before the first
        # forecast horizon).
        wedge_series = (headline_mom - trimmed_mom).dropna()
        if wedge_series.empty:
            return self._fallback(panel, horizon)
        recent_wedge = wedge_series.tail(self._WEDGE_WINDOW)
        wedge_mean = float(recent_wedge.mean())
        # Variance of the wedge (sample variance is fine here — we only
        # need it as a noise contribution to the 80% bands).
        wedge_var = float(recent_wedge.var(ddof=1)) if len(recent_wedge) > 1 else 0.0
        if not np.isfinite(wedge_var) or wedge_var < 0:
            wedge_var = 0.0

        # ----- Features -----
        # Use the standard feature builder. The trimmed-mean column will
        # already be in the panel and may flow into engineered features
        # downstream, which is fine — we're predicting trimmed_mom now.
        X_full = build_features(panel)
        live_row = self._latest_feature_row(X_full)

        # ----- Per-horizon direct prediction in TRIMMED MoM space -----
        emp_sd = self._empirical_mom_std(cpi)
        trim_means = np.empty(horizon, dtype=float)
        trim_sd = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                mu, sd = self._fit_one_horizon(X_full, trimmed_mom, h, live_row)
            except Exception:
                mu, sd = self._fallback_step_trimmed(trimmed_level, h)
            trim_means[i] = mu
            trim_sd[i] = sd

        # ----- Convert trimmed forecast → headline forecast -----
        # Add the wedge mean elementwise.
        headline_means = trim_means + wedge_mean

        # ----- 80% bands -----
        # Add trimmed-model residual variance and wedge variance in
        # quadrature. Floor the std so bands don't collapse on a quiet
        # trimmed-CPI training window.
        spreads = np.empty(horizon, dtype=float)
        for i in range(horizon):
            sd = float(np.sqrt(max(trim_sd[i], 0.0) ** 2 + wedge_var))
            sd = max(sd, emp_sd, 0.10)
            spreads[i] = self._Z80 * sd

        los = headline_means - spreads
        his = headline_means + spreads
        return headline_means, los, his

    # ------------------------------------------------------------------
    # per-horizon model: predicts TRIMMED MoM
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        trimmed_mom: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Fit ridge + xgb on (X_T, trimmed_mom_{T+h}). Returns (mu, resid_std)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        target = trimmed_mom.shift(-h).rename("y_target")

        df = X_full.join(target, how="inner").dropna()
        if len(df) < 36:
            raise RuntimeError("not enough rows for trimmed direct horizon model")

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)
        if not np.all(np.isfinite(x_live)):
            col_means = np.nanmean(X, axis=0)
            mask = ~np.isfinite(x_live[0])
            x_live[0, mask] = col_means[mask]

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
            mu = ridge_pred
            resid = ridge_resid
        else:
            mu = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        sd = float(np.std(resid))
        return mu, sd

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="all")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        last = feats.iloc[-1].copy()
        if last.isna().any():
            filled = feats.ffill().iloc[-1]
            last = last.where(~last.isna(), filled)
        return last

    @staticmethod
    def _empirical_mom_std(cpi: pd.Series) -> float:
        mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = mom.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    @staticmethod
    def _fallback_step_trimmed(
        trimmed_level: pd.Series, h: int
    ) -> tuple[float, float]:
        mom = (np.log(trimmed_level) - np.log(trimmed_level.shift(1))) * 100.0
        s = mom.dropna()
        if s.empty:
            return 0.0, 0.20
        last = float(s.iloc[-1])
        sd = float(s.tail(60).std()) if len(s) >= 12 else 0.20
        return last, max(sd, 0.10)

    # ------------------------------------------------------------------
    # whole-strategy fallback (headline persistence)
    # ------------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            cpi = panel[TARGET.fred_id].astype(float).dropna()
            mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
            s = mom.dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
            sd = max(sd, 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
