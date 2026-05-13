"""Recession-conditional CPI forecaster (Agent XX).

The macro environment has two modes that produce systematically
different CPI dynamics:

  - "Normal" expansion: services-driven sticky inflation, energy and
    goods pass-throughs dominate the lag structure.
  - "Recession-risk" mode: credit spreads blow out, the yield curve
    inverts, demand collapses ~6-12 months later, and CPI prints
    decelerate sharply (see 1990, 2001, 2008, 2020).

A single linear model averaged across both regimes is forced to fit
the *mean* of two very different conditional distributions and ends
up wrong in both. So instead we train **two** ridge models with
sample weights:

  - Model A is fit with weight = (1 - recession_risk_t) and so it
    leans on normal-regime months.
  - Model B is fit with weight = (recession_risk_t + 0.1) so it
    leans on stress months but always sees *some* signal even in
    backtests where stress data is thin.

At inference we read the current recession-risk score from the latest
HY spread (BAMLH0A0HYM2) and 10y-2y curve (T10Y2Y) and blend:

    yhat = current_risk * yhat_B + (1 - current_risk) * yhat_A.

Recession risk uses two simple, well-known thresholds:

  - HY spread > 5% (above ~5% the marginal HY borrower is being
    repriced — historically signals stress).
  - 10y-2y < -0.2% (clearly inverted, not just flat).

We use a sigmoid blend of the two indicator counts so the score is
continuous and 0/0.5/1 isn't a sharp step. As a fallback, if both
series are missing we degrade gracefully to a single Ridge fit on
all data with uniform weights. If recession-regime data is too thin
(< 24 weighted obs) we add an XGBoost layer on the recession side to
borrow nonlinear capacity from the few stress observations.

80% bands come from per-horizon weighted residual std, floored at
0.10 like the other direct strategies.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


_HY_SPREAD_ID = "BAMLH0A0HYM2"
_T10Y2Y = "T10Y2Y"


class RecessionConditionalStrategy(ForecastStrategy):
    name = "agent_xx_recession"

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
    # Recession-risk thresholds.
    _HY_STRESS_THRESH = 5.0    # HY spread > 5% -> stress signal
    _CURVE_INV_THRESH = -0.2   # T10Y2Y < -0.2% -> clear inversion
    # Effective-sample-size threshold below which we add XGBoost on
    # the recession side to compensate for weighted-data thinness.
    _ESS_THIN = 24.0

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

        # Recession-risk score per month (NaN where neither series is
        # available; values in [0, 1]).
        risk = self._recession_risk(panel)

        # Reindex to the feature index for join-friendly downstream use.
        risk_aligned = risk.reindex(X_full.index)

        # Current-state risk (latest non-NaN).
        current_risk = self._latest_risk(risk_aligned)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(
                    X_full, y_full, risk_aligned, h, live_row, current_risk
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
    # recession-risk score
    # ------------------------------------------------------------------
    def _recession_risk(self, panel: pd.DataFrame) -> pd.Series:
        """Per-month recession-risk score in [0, 1].

        Returns a Series indexed by panel.index. NaN where neither
        underlying series is available.
        """
        # Pull each indicator if present.
        hy = (
            pd.to_numeric(panel[_HY_SPREAD_ID], errors="coerce")
            if _HY_SPREAD_ID in panel.columns
            else pd.Series(np.nan, index=panel.index)
        )
        curve = (
            pd.to_numeric(panel[_T10Y2Y], errors="coerce")
            if _T10Y2Y in panel.columns
            else pd.Series(np.nan, index=panel.index)
        )

        # Boolean indicators. Treat NaN as "not signaling stress" so a
        # single-series environment doesn't artificially zero the score.
        hy_stress = (hy > self._HY_STRESS_THRESH).astype(float)
        hy_stress = hy_stress.where(hy.notna(), other=np.nan)

        curve_inv = (curve < self._CURVE_INV_THRESH).astype(float)
        curve_inv = curve_inv.where(curve.notna(), other=np.nan)

        # Combine. Score = sigmoid-like map of the count of triggered
        # signals. 0 signals -> ~0.27, 1 -> 0.5, 2 -> ~0.73 from a
        # standard logistic on (count - 1). That keeps the score
        # continuous (avoids a hard 0/0.5/1 step) and properly bounded.
        count = hy_stress.fillna(0.0) + curve_inv.fillna(0.0)
        # If BOTH are NaN, the score should also be NaN (no info).
        both_nan = hy.isna() & curve.isna()
        score = 1.0 / (1.0 + np.exp(-(count - 1.0)))
        score = score.where(~both_nan, other=np.nan)

        # Lag by 1 so the row labelled T uses only info from T-1, the
        # same convention as build_features.
        return score.shift(1)

    @staticmethod
    def _latest_risk(risk: pd.Series) -> float:
        """Most recent finite recession-risk value, or 0.5 if none."""
        s = risk.dropna()
        if s.empty:
            return 0.5
        return float(np.clip(s.iloc[-1], 0.0, 1.0))

    # ------------------------------------------------------------------
    # per-horizon fit: two models blended by current_risk
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        risk_aligned: pd.Series,
        h: int,
        live_row: pd.Series,
        current_risk: float,
    ) -> tuple[float, float]:
        from sklearn.linear_model import Ridge, RidgeCV
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

        # Risk values aligned to df.index. Where missing, treat as 0
        # (no recession signal — the safe-side default that lets normal
        # observations stay in Model A).
        risk_vec = (
            risk_aligned.reindex(df.index).fillna(0.0).values.astype(float)
        )
        risk_vec = np.clip(risk_vec, 0.0, 1.0)

        # Sample weights for the two regimes.
        w_normal = 1.0 - risk_vec                   # model A
        w_stress = risk_vec + 0.1                   # model B (always >0)

        # Standardize once; both ridge models share the scaler.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        # ---- Model A: pick alpha by CV on the unweighted problem so
        # we don't overfit to the weight pattern, then refit Ridge with
        # weights at that alpha.
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            alpha_cv = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y).alpha_
        except Exception:
            alpha_cv = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y).alpha_

        # Guard against degenerate (all-zero) weights.
        if w_normal.sum() <= 1e-6:
            w_normal_use = np.ones_like(w_normal)
        else:
            w_normal_use = w_normal

        if w_stress.sum() <= 1e-6:
            w_stress_use = np.ones_like(w_stress)
        else:
            w_stress_use = w_stress

        ridge_A = Ridge(alpha=alpha_cv).fit(Xs, y, sample_weight=w_normal_use)
        ridge_B = Ridge(alpha=alpha_cv).fit(Xs, y, sample_weight=w_stress_use)

        pred_A = float(ridge_A.predict(x_live_s)[0])
        pred_B = float(ridge_B.predict(x_live_s)[0])
        resid_A = y - ridge_A.predict(Xs)
        resid_B = y - ridge_B.predict(Xs)

        # If recession-side data is thin (effective-sample-size on the
        # stress weights is small), mix in XGBoost for Model B to give
        # it some nonlinear capacity. Floor weights at 0 for ESS calc.
        ess_B = float(w_stress_use.sum() ** 2 / max(np.sum(w_stress_use ** 2), 1e-9))
        if ess_B < self._ESS_THIN:
            try:
                from xgboost import XGBRegressor

                xgb = XGBRegressor(**self._XGB_PARAMS).fit(
                    X, y, sample_weight=w_stress_use
                )
                xgb_pred = float(xgb.predict(x_live)[0])
                xgb_resid = y - xgb.predict(X)
                # Half ridge_B, half xgb on the stress side.
                pred_B = 0.5 * pred_B + 0.5 * xgb_pred
                resid_B = 0.5 * resid_B + 0.5 * xgb_resid
            except Exception:
                pass

        # ---- Blend by current recession-risk score.
        r = float(np.clip(current_risk, 0.0, 1.0))
        yhat = r * pred_B + (1.0 - r) * pred_A
        resid_blend = r * resid_B + (1.0 - r) * resid_A

        resid_std = float(np.std(resid_blend))
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
