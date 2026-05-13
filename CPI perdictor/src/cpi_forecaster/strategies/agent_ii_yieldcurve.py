"""Yield curve + monetary policy regime strategy.

The yield curve carries forward-looking information that lagging macro
features miss. The 10y-2y and 10y-3m spreads have led every U.S.
recession since the 1970s by 6-18 months, and recessions reliably drag
inflation down. The 2y minus fed funds spread tells us where the bond
market thinks policy is going relative to where the Fed has it now —
a direct read on expected disinflation/reinflation pressure.

So this strategy augments the standard feature set with curve-shape
covariates at multiple lags (to capture the lead-time structure) and
hands them to the same Ridge + XGBoost direct-multistep ensemble that
agent_b uses. If the curve series aren't in the panel we silently fall
back to the plain feature set.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# Series IDs we look for. If any are missing we just skip the
# corresponding curve features — the strategy still runs.
_T10Y2Y = "T10Y2Y"
_T10Y3M = "T10Y3M"
_DGS2 = "DGS2"
_FEDFUNDS = "FEDFUNDS"


def _augment_with_curve_features(
    X: pd.DataFrame, panel: pd.DataFrame
) -> pd.DataFrame:
    """Add yield-curve-shape features to X. Skip any series not in panel.

    All curve features are shifted by 1 month so the row labelled T uses
    only information available at the end of T-1 — matches the
    convention in build_features and avoids any leakage.
    """
    extras: dict[str, pd.Series] = {}

    if _T10Y2Y in panel.columns:
        s = panel[_T10Y2Y]
        # Level + lags. The 6/12-month lags matter because curve
        # inversions lead the inflation response by quarters, not weeks.
        extras["T10Y2Y_lag1"] = s.shift(1)
        extras["T10Y2Y_lag6"] = s.shift(6)
        extras["T10Y2Y_lag12"] = s.shift(12)
        # Inversion dummy: 1 when the curve is inverted at T-1.
        extras["is_inverted_lag1"] = (s.shift(1) < 0.0).astype(float)

    if _T10Y3M in panel.columns:
        s = panel[_T10Y3M]
        extras["T10Y3M_lag1"] = s.shift(1)
        extras["T10Y3M_lag6"] = s.shift(6)

    # Market-vs-Fed wedge: where the 2y rate sits relative to the fed
    # funds rate. Positive = market expects hikes; negative = market
    # expects cuts (typically because it expects disinflation).
    if _DGS2 in panel.columns and _FEDFUNDS in panel.columns:
        wedge = panel[_DGS2] - panel[_FEDFUNDS]
        extras["dgs2_minus_ff_lag1"] = wedge.shift(1)

    # 2y MoM change — a fast read on policy-path repricing.
    if _DGS2 in panel.columns:
        dgs2 = panel[_DGS2]
        extras["DGS2_mom_lag1"] = (dgs2 - dgs2.shift(1)).shift(1)

    if not extras:
        return X

    add = pd.concat(extras, axis=1)
    # Reindex to X's index so the join is clean even when panel has
    # extra rows beyond the feature window.
    add = add.reindex(X.index)
    return pd.concat([X, add], axis=1)


class YieldCurveStrategy(ForecastStrategy):
    name = "agent_ii_yieldcurve"

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
        X_full = build_features(panel)
        X_full = _augment_with_curve_features(X_full, panel)
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
