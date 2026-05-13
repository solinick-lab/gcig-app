"""Credit spreads as a leading indicator (Agent MM).

The new panel includes BAMLH0A0HYM2 — the ICE BofA US High-Yield index
option-adjusted spread. Credit spreads are one of the oldest "smart-money"
financial-conditions gauges:

  - When HY spreads WIDEN, the marginal borrower is being repriced,
    funding costs jump, and risky firms cut hiring/inventory. That's a
    classic precursor to demand softening — and softer demand pulls
    inflation down 6-12 months later.
  - When HY spreads are TIGHT (sub-4% historically), financial conditions
    are loose, risk appetite is high, and demand-pull inflation tends to
    stay sticky or accelerate.

This strategy bolts a small, focused credit-stress feature block onto
the standard `build_features` matrix and trains a direct multi-step
Ridge + XGB ensemble (50/50 mean) per horizon. The credit features are:

  - HY spread level lag 1, 3, 6 (so we capture the recent regime AND
    where it was half a year ago, which matters for the lag-to-CPI).
  - HY spread 3-month and 6-month change (acceleration / direction).
  - HY spread 60-month rolling z-score (regime-relative stress).
  - Tight-credit dummy (HY level < 4%) — a hard threshold capturing
    "loose conditions" episodes.

Forecast intervals come from per-horizon training residual std with
z=1.2816, floored at 0.10 like other direct-style strategies.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# FRED ID for the ICE BofA US High-Yield Master II OAS.
_HY_SPREAD_ID = "BAMLH0A0HYM2"


class CreditSpreadStrategy(ForecastStrategy):
    name = "agent_mm_credit"

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
    _RESID_FLOOR = 0.10
    _TIGHT_THRESHOLD = 4.0  # HY < 4% counts as loose financial conditions
    _ZSCORE_WINDOW = 60  # 5y rolling for regime-relative stress

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

        # Augment with credit-stress features. If the HY series is missing
        # entirely, _credit_features returns an empty frame and we fall
        # back to plain build_features.
        credit = self._credit_features(panel)
        if not credit.empty:
            X_full = X_full.join(credit, how="left")

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
    # credit feature block
    # ------------------------------------------------------------------
    def _credit_features(self, panel: pd.DataFrame) -> pd.DataFrame:
        """Build the credit-spread feature block.

        All features are lag-1 (or longer) so they only use information
        available by the END of month T-1 when predicting month T+. This
        matches the leakage convention of `build_features`.
        """
        if _HY_SPREAD_ID not in panel.columns:
            return pd.DataFrame(index=panel.index)

        hy = pd.to_numeric(panel[_HY_SPREAD_ID], errors="coerce")
        if hy.dropna().empty:
            return pd.DataFrame(index=panel.index)

        cols: dict[str, pd.Series] = {}

        # Level lags — capture current and historic stress.
        cols["hy_spread_lag1"] = hy.shift(1)
        cols["hy_spread_lag3"] = hy.shift(3)
        cols["hy_spread_lag6"] = hy.shift(6)

        # Multi-month change. (Lag 1 so we use only the past.)
        cols["hy_spread_chg_3mo_lag1"] = (hy - hy.shift(3)).shift(1)
        cols["hy_spread_chg_6mo_lag1"] = (hy - hy.shift(6)).shift(1)

        # Rolling z-score vs ~5y history. min_periods keeps it sane in
        # short-history backtests; lag 1 prevents leakage.
        roll_mean = hy.rolling(self._ZSCORE_WINDOW, min_periods=12).mean()
        roll_std = hy.rolling(self._ZSCORE_WINDOW, min_periods=12).std()
        zscore = (hy - roll_mean) / roll_std.replace(0.0, np.nan)
        cols["hy_spread_zscore_lag1"] = zscore.shift(1)

        # Tight-credit dummy: 1 if HY < 4% (loose conditions, demand-pull
        # pressure tends to persist).
        tight = (hy < self._TIGHT_THRESHOLD).astype(float)
        # When hy is NaN the comparison is False — restore NaN so the
        # dropna in supervised assembly handles it cleanly.
        tight = tight.where(hy.notna(), other=np.nan)
        cols["hy_tight_dummy_lag1"] = tight.shift(1)

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

        # ---- XGBoost (best-effort) ----
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
            # 50/50: ridge anchors scale, xgb picks up nonlinearities like
            # the regime-shift behavior around tight-credit episodes.
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        resid_std = float(np.std(resid))
        resid_std = max(resid_std, self._RESID_FLOOR)
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
