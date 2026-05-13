"""Monotonic-constrained XGBoost.

Inflation has known economic priors: oil/gas prices up should not
predict CPI down; rising unemployment should not predict CPI up
(Phillips curve, modestly); wage growth and money supply expansion
push CPI up. Encoding these as monotonic constraints in XGBoost
prevents the trees from learning spurious reversals on the small
monthly panel and improves out-of-sample stability — the model can
still learn the magnitude/timing of the response, it just can't flip
the sign.

Strategy:
  1. Build the standard feature matrix (build_features) and inspect
     the named columns to map each one to an economic concept.
  2. Construct a `monotone_constraints` tuple of length n_features:
       +1 for oil/gas/PPI/wages/MICH/M2 (more → CPI up)
       -1 for UNRATE (more → CPI down)
        0 for everything else (CPI lags, calendar, rates, FX, IP, etc.)
  3. Direct multi-step: train a separate XGB + Ridge ensemble per
     horizon h in 1..H against y_{T+h}. The ridge member has no
     constraints and captures everything the constrained XGB can't.
  4. 50/50 ensemble; 80% bands from residual std × z=1.2816.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# Map FRED series IDs to the sign of their expected effect on CPI.
# +1 = monotonically increasing in CPI, -1 = decreasing, 0 = no constraint.
_SIGN_BY_SERIES: dict[str, int] = {
    # Energy: direct cost-push.
    "DCOILWTICO": +1,  # WTI Oil
    "GASREGW": +1,     # Retail Gas
    # Producer prices: pipeline pressure into consumer prices.
    "PPIACO": +1,      # PPI All Commodities
    "PPIFIS": +1,      # PPI Final Demand
    # Wages: labor-cost channel.
    "CES0500000003": +1,  # Avg Hourly Earnings
    # Inflation expectations: self-fulfilling.
    "MICH": +1,        # Michigan 1Y Inflation Expectations
    # Money supply: classic monetarist channel.
    "M2SL": +1,        # M2 Money Stock
    # Phillips curve (modest): slack pushes CPI down.
    "UNRATE": -1,      # Unemployment Rate
    # No strong directional prior — let the model decide:
    "CSUSHPISA": 0,    # Case-Shiller (lags shelter, complicated)
    "CUSR0000SAH1": 0, # CPI Shelter (component of target — leakage-y as a constraint)
    "DTWEXBGS": 0,     # USD Index (sign depends on import share)
    "DGS10": 0,        # 10Y Treasury Yield (forward-looking, ambiguous)
    "INDPRO": 0,       # Industrial Production (cycle indicator)
    "RSAFS": 0,        # Retail Sales (demand-side, ambiguous)
}


def _constraint_for_column(col: str) -> int:
    """Return +1/-1/0 for a feature column based on its FRED series ID prefix.

    Feature columns built by `build_features` are named:
      - cpi_mom_lag1, cpi_mom_lag2, cpi_mom_lag3, cpi_yoy_lag1
      - <FRED_ID>_mom_lag1, <FRED_ID>_3mo_lag1, <FRED_ID>_yoy_lag1
      - month_sin, month_cos
    We don't constrain CPI lags or calendar terms (sign is ambiguous /
    cyclical). For macro features, look up the series ID prefix.
    """
    # CPI lags: no constraint (autoregressive structure, can be either sign).
    if col.startswith("cpi_"):
        return 0
    # Calendar: no constraint.
    if col in ("month_sin", "month_cos"):
        return 0
    # Macro features named "<FRED_ID>_<transform>_lag1".
    for series_id, sign in _SIGN_BY_SERIES.items():
        if col.startswith(series_id + "_"):
            return sign
    return 0


class MonotonicXgbStrategy(ForecastStrategy):
    name = "agent_x_monotonic"

    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)
    _XGB_PARAMS = dict(
        n_estimators=400,
        max_depth=3,
        learning_rate=0.04,
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

        # Build the monotone_constraints tuple in the SAME column order
        # we just sliced X with — column order is what XGBoost matches on.
        monotone_constraints = tuple(_constraint_for_column(c) for c in feature_cols)
        assert len(monotone_constraints) == X.shape[1]

        # ---- Ridge (no constraints, captures linear & negative effects) ----
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

        # ---- Monotonic XGBoost ----
        xgb_pred: float | None = None
        xgb_resid: np.ndarray | None = None
        try:
            from xgboost import XGBRegressor

            model = XGBRegressor(
                monotone_constraints=monotone_constraints,
                **self._XGB_PARAMS,
            ).fit(X, y)
            xgb_pred = float(model.predict(x_live)[0])
            xgb_resid = y - model.predict(X)
        except Exception:
            xgb_pred = None
            xgb_resid = None

        if xgb_pred is None:
            yhat = ridge_pred
            resid = ridge_resid
        else:
            # 50/50 ensemble — ridge anchors level/sign coverage,
            # constrained XGB picks up monotone nonlinearities.
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
