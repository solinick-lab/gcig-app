"""Services-inflation tracker (Agent FFF, round 5).

The "services" core component of CPI is the slow, sticky portion that
moves with wages, shelter, and inflation expectations. It dominates
medium- and long-horizon CPI dynamics: commodity shocks fade in a
month or two, but services drift takes quarters to roll over. So a
forecaster aimed at h=2/h=3 should arguably listen ONLY to services
drivers and ignore the noisy commodity stuff.

Hypothesis: by dropping noisy commodity features (oil, gas, broad PPI,
USD, etc.) we trade some short-run signal for cleaner long-run
generalization. At h=2/h=3 services dominates and the model should win.

Feature set — minimal, services-only:
  * CPI MoM lags 1, 2, 3, 12 (no other CPI internals)
  * For each services driver: MoM lag1, YoY lag1, 3mo lag1
    drivers = [CES0500000003 (Avg Hourly Earnings),
               CSUSHPISA      (Case-Shiller),
               CUSR0000SAH1   (CPI Shelter),
               MICH           (1Y inflation expectations),
               STICKCPIM157SFRBATL (Sticky CPI),
               JTSQUL         (JOLTS Quits — wage pressure),
               JTSJOL         (JOLTS Openings),
               UNRATE         (Unemployment)]

Modeling:
  * Direct multi-step: train one model per horizon h on (X_T, y_{T+h}).
  * Per-horizon Ridge (TimeSeriesSplit-CV alpha) + XGBoost; equal weight.
  * 80% bands from per-horizon residual std (z=1.2816).
  * Graceful fallbacks if drivers are missing or training fails.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


# Services-side drivers. Exclude commodities (oil, gas, PPI, USD, yields,
# credit spreads) on purpose — that's the angle.
_SERVICES_DRIVERS: tuple[str, ...] = (
    "CES0500000003",       # Avg Hourly Earnings (wages)
    "CSUSHPISA",           # Case-Shiller Home Price (shelter leading)
    "CUSR0000SAH1",        # CPI Shelter (rents + OER)
    "MICH",                # Michigan 1Y inflation expectations
    "STICKCPIM157SFRBATL", # Atlanta Fed Sticky CPI
    "JTSQUL",              # JOLTS Quits (wage-pressure indicator)
    "JTSJOL",              # JOLTS Openings (labor demand)
    "UNRATE",              # Unemployment
)


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _3mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(3) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


class ServicesTrackerStrategy(ForecastStrategy):
    name = "agent_fff_services"

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
        X_full = self._build_services_features(panel)
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
    # services-only feature matrix
    # ------------------------------------------------------------------
    @classmethod
    def _build_services_features(cls, panel: pd.DataFrame) -> pd.DataFrame:
        """Minimal services-focused feature matrix.

        Columns:
          - cpi_mom_lag1, cpi_mom_lag2, cpi_mom_lag3, cpi_mom_lag12
          - For each available services driver:
              <ID>_mom_lag1, <ID>_yoy_lag1, <ID>_3mo_lag1

        Anything missing from `panel` is silently skipped — graceful
        degradation rather than crashing the race.
        """
        if TARGET.fred_id not in panel.columns:
            raise RuntimeError(
                f"Panel missing target series {TARGET.fred_id}; "
                "services tracker cannot build features."
            )

        cpi = panel[TARGET.fred_id].astype(float)
        cpi_mom = _log_mom(cpi)

        cols: dict[str, pd.Series] = {
            "cpi_mom_lag1": cpi_mom.shift(1),
            "cpi_mom_lag2": cpi_mom.shift(2),
            "cpi_mom_lag3": cpi_mom.shift(3),
            "cpi_mom_lag12": cpi_mom.shift(12),
        }

        for sid in _SERVICES_DRIVERS:
            if sid not in panel.columns:
                continue
            s = panel[sid].astype(float)
            cols[f"{sid}_mom_lag1"] = _mom(s).shift(1)
            cols[f"{sid}_yoy_lag1"] = _yoy(s).shift(1)
            cols[f"{sid}_3mo_lag1"] = _3mo(s).shift(1)

        feats = pd.concat(cols, axis=1)
        feats = feats.loc[:, ~feats.columns.duplicated()]
        return feats

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
            # Equal-weight blend per spec.
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
