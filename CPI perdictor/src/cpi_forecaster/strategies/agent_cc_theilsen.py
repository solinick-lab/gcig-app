"""Robust regression strategy: Theil-Sen + RANSAC + small XGBoost ensemble.

CPI series have occasional violent outliers (oil shocks, COVID supply
chain, 2022 inflation spike). Ordinary least squares — and even Ridge —
get yanked around by these tails: a handful of months drag the slope
estimates and bleed into every horizon's forecast.

Two estimators here are designed to ignore that kind of contamination:

  - TheilSenRegressor: estimates each coefficient as the median of slopes
    across data subsamples. Breakdown point ~29% — you can corrupt nearly
    a third of the data and the fit is still close to the clean signal.
  - RANSACRegressor: random sample consensus. Repeatedly fits a base
    estimator to a small random subset, scores the rest as inlier or
    outlier against a residual threshold, and keeps the largest-consensus
    fit. Inherently rejects outliers rather than just down-weighting them.

Both are slow on the full feature set with naive defaults — Theil-Sen's
median-of-slopes scales combinatorially with feature count, so we cap
``max_subpopulation`` and ``n_subsamples`` aggressively to stay well
under the per-cut budget. The third leg is a small XGBoost to pick up
nonlinearity the linear robust models can't capture.

Direct multi-step (one model per horizon, no chaining) keeps error from
compounding. Intervals come from a robust scale estimate of training
residuals — MAD * 1.4826 — so a few wild residuals don't blow the bands
out. Same z=1.2816 for the 80% one-sided spread as the other strategies.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class TheilSenStrategy(ForecastStrategy):
    name = "agent_cc_theilsen"

    # Robust-regression knobs. The combinatorial cost of Theil-Sen scales
    # roughly with C(n_samples, n_subsamples) capped by max_subpopulation;
    # these values keep the per-horizon fit in the few-hundred-ms range
    # even with ~40 features, while still giving the median-of-slopes
    # estimator enough draws to be stable.
    _THEILSEN_PARAMS = dict(
        max_subpopulation=1000,
        n_subsamples=20,
        max_iter=300,
        random_state=42,
        n_jobs=1,
        fit_intercept=True,
    )

    # RANSAC: 70% inlier fraction is a reasonable assumption for monthly
    # CPI data — the COVID/2022 spikes are rare enough that the bulk of
    # the panel is clean. Residual threshold is filled in per-fit from
    # the MAD of y so it adapts to the target's natural scale at each
    # horizon (longer horizons have wider y distributions).
    _RANSAC_PARAMS = dict(
        min_samples=0.7,
        max_trials=200,
        random_state=42,
    )

    _XGB_PARAMS = dict(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_lambda=1.0,
        objective="reg:squarederror",
        n_jobs=1,
        verbosity=0,
        random_state=42,
    )

    _Z80 = 1.2816  # one-sided z for 80% interval
    _MAD_SCALE = 1.4826  # MAD -> std for normal data

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
                yhat, robust_scale = self._fit_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                yhat = self._last_observed_mom(y_full)
                robust_scale = max(self._empirical_mom_std(y_full), 0.15)

            spread = self._Z80 * robust_scale
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
        """Train Theil-Sen + RANSAC + XGB for horizon h. Returns (mean, robust_scale)."""
        from sklearn.linear_model import (
            RANSACRegressor,
            Ridge,
            TheilSenRegressor,
        )
        from sklearn.preprocessing import StandardScaler

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            scale = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, scale

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Standardize once — both linear robust regressors and XGB are
        # fine with standardized inputs, and Theil-Sen in particular
        # behaves better numerically when features are on the same scale.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        preds: list[float] = []
        residuals: list[np.ndarray] = []

        # ---- Theil-Sen ----
        try:
            ts = TheilSenRegressor(**self._THEILSEN_PARAMS).fit(Xs, y)
            ts_pred = float(ts.predict(x_live_s)[0])
            ts_resid = y - ts.predict(Xs)
            preds.append(ts_pred)
            residuals.append(ts_resid)
        except Exception:
            pass

        # ---- RANSAC (Ridge base) ----
        # Adapt the residual threshold to the target's MAD: 2.5x MAD is
        # a standard "outside the bulk of the data" cutoff for normal-
        # ish residuals, generalized robustly via MAD.
        try:
            mad_y = self._mad(y)
            resid_thresh = max(2.5 * mad_y * self._MAD_SCALE, 0.2)
            ransac = RANSACRegressor(
                estimator=Ridge(alpha=1.0),
                residual_threshold=resid_thresh,
                **self._RANSAC_PARAMS,
            ).fit(Xs, y)
            ransac_pred = float(ransac.predict(x_live_s)[0])
            ransac_resid = y - ransac.predict(Xs)
            preds.append(ransac_pred)
            residuals.append(ransac_resid)
        except Exception:
            pass

        # ---- XGBoost (uses raw X — trees are scale-invariant) ----
        try:
            from xgboost import XGBRegressor

            xgb = XGBRegressor(**self._XGB_PARAMS).fit(X, y)
            xgb_pred = float(xgb.predict(x_live)[0])
            xgb_resid = y - xgb.predict(X)
            preds.append(xgb_pred)
            residuals.append(xgb_resid)
        except Exception:
            pass

        if not preds:
            # Everything failed: graceful fallback so the cut still
            # produces a number.
            yhat = self._last_observed_mom(y_full)
            scale = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, scale

        # Equal-weight ensemble across whichever models successfully fit.
        yhat = float(np.mean(preds))
        avg_resid = np.mean(np.vstack(residuals), axis=0)

        # Robust scale: MAD * 1.4826 ≈ std for normal data, but immune to
        # the kind of huge residuals around shocks that would inflate
        # the plain sample std and balloon the interval.
        robust_scale = self._MAD_SCALE * self._mad(avg_resid)
        # Floor so very tight in-sample fits at short horizons don't
        # produce unrealistically narrow intervals.
        robust_scale = max(robust_scale, 0.10)
        return yhat, robust_scale

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _mad(a: np.ndarray) -> float:
        """Median absolute deviation from the median (robust scale)."""
        a = np.asarray(a, dtype=float)
        if a.size == 0:
            return 0.0
        med = np.median(a)
        return float(np.median(np.abs(a - med)))

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
