"""Agent OO — consumer sentiment & inflation expectations specialist.

The panel carries THREE different views of inflation expectations:
  - MICH    : Michigan 1Y survey expectations (households).
  - T5YIE   : 5Y TIPS breakeven (markets, capital at risk).
  - T10YIE  : 10Y TIPS breakeven (longer-horizon markets).
  - UMCSENT : University of Michigan consumer sentiment level — not a
              direct expectation of inflation, but a strong proxy for
              household demand pressure that feeds into pricing power.

Each view has a distinct bias: surveys overshoot during food/gas spikes,
markets carry liquidity & inflation-risk premia, sentiment reads demand
broadly. The DIFFERENCES between them are informative — when survey
expectations diverge sharply from market breakevens, one of them is
mispriced and CPI tends to drift toward whichever side has the cleaner
signal for the regime. Sentiment shifts also tend to lead realised CPI
turning points by a few months.

This strategy builds the standard `build_features` matrix and bolts on
an "expectations & sentiment" block:
  - UMCSENT level (lag 1), MoM change, 3-month change.
  - MICH - T5YIE divergence (survey vs market expectations).
  - T5YIE - T10YIE expectations curve slope.
  - Composite expectations (mean of MICH, T5YIE, T10YIE).

Per horizon, fit Ridge + XGBoost and 50/50 blend, with 80% bands from
per-horizon residual std (z=1.2816, floored). Falls back to the standard
features path if the sentiment columns aren't present.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


_SENTIMENT_IDS = ("UMCSENT", "MICH", "T5YIE", "T10YIE")


def _mom_pct(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


class SentimentStrategy(ForecastStrategy):
    name = "agent_oo_sentiment"

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

    # --------------------------------------------------------------
    # entry point
    # --------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    def _inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = self._build_features(panel)
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

    # --------------------------------------------------------------
    # feature engineering — build_features + sentiment/expectations
    # --------------------------------------------------------------
    def _build_features(self, panel: pd.DataFrame) -> pd.DataFrame:
        base = build_features(panel)

        rows: dict[str, pd.Series] = {}
        cols = panel.columns

        # ---- UMCSENT block ----
        if "UMCSENT" in cols:
            sent = panel["UMCSENT"]
            rows["umcsent_lvl_lag1"] = sent.shift(1)
            rows["umcsent_mom_lag1"] = _mom_pct(sent).shift(1)
            rows["umcsent_chg3m_lag1"] = (sent - sent.shift(3)).shift(1)

        # ---- Survey vs market divergence ----
        if "MICH" in cols and "T5YIE" in cols:
            divergence = panel["MICH"] - panel["T5YIE"]
            rows["mich_minus_t5yie_lag1"] = divergence.shift(1)

        # ---- Expectations curve slope ----
        if "T5YIE" in cols and "T10YIE" in cols:
            slope = panel["T5YIE"] - panel["T10YIE"]
            rows["t5_minus_t10_lag1"] = slope.shift(1)

        # ---- Composite expectations (mean of available views) ----
        exp_components = [c for c in ("MICH", "T5YIE", "T10YIE") if c in cols]
        if exp_components:
            comp = pd.concat(
                [panel[c] for c in exp_components], axis=1
            ).mean(axis=1, skipna=True)
            rows["exp_composite_lag1"] = comp.shift(1)

        if not rows:
            # No sentiment columns at all — just return the base matrix.
            return base

        extra = pd.concat(rows, axis=1)
        feats = base.join(extra, how="left")
        return feats

    # --------------------------------------------------------------
    # per-horizon fit — Ridge + XGBoost ensemble
    # --------------------------------------------------------------
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

        # ---- Ridge w/ time-series CV alpha ----
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

        # ---- XGBoost (fall back to ridge-only if unavailable) ----
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

    # --------------------------------------------------------------
    # helpers
    # --------------------------------------------------------------
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

    # --------------------------------------------------------------
    # whole-strategy fallback
    # --------------------------------------------------------------
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
