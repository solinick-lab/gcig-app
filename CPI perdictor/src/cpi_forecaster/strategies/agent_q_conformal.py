"""Conformal-calibrated quantile regression.

Builds on agent_g_quantile (the current race leader) by adding a SPLIT
CONFORMAL PREDICTION calibration step. The motivation is twofold:

  1. Coverage guarantee: separately-trained quantile GBRs are not
     guaranteed to produce well-calibrated 80% intervals. With finite
     data and asymmetric loss, the empirical coverage of the [q=0.1,
     q=0.9] band can be far from 80%. Split conformal fixes this in a
     model-agnostic way: by the exchangeability argument, the conformal
     interval covers ~80% of future observations REGARDLESS of how good
     the underlying quantile model is.

  2. Bias-corrected median: the calibration set also gives us a clean
     out-of-sample residual sample. We add the mean of the calibration
     residuals (signed) back to the median prediction to debias it.
     This is a small but cheap improvement on the point forecast.

Procedure (per horizon h):
  - Split the (X_T, y_{T+h}) supervised pairs CHRONOLOGICALLY into
    proper-train (first 80%) and calibration (last 20%).
  - Fit three GBRs (alpha = 0.1, 0.5, 0.9) on proper-train.
  - Predict on the calibration set; compute non-conformity scores
        r_i = max(yhat_lo_i - y_i, y_i - yhat_hi_i, 0)
  - q_hat = the ceil((n+1)*(1 - alpha)) / n quantile of {r_i} with
    alpha = 0.20. (Standard finite-sample correction.)
  - Re-fit all three GBRs on the FULL training set (calibration done,
    so we don't waste the 20% at inference time).
  - Predict the live row; output:
        lo80 = yhat_lo - q_hat
        hi80 = yhat_hi + q_hat
        mean = yhat_mid + median_bias
    where median_bias = mean of signed (y - yhat_mid) on calibration.

Defensive: same as agent_g — the entry point is wrapped in try/except
and falls back to a persistence forecast if anything goes wrong. Each
horizon also has its own try/except so a single bad fit doesn't kill
the whole forecast.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ---- constants ------------------------------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval (fallback only)
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MIN_TRAIN_ROWS = 36          # below this we don't fit the GBR
_MIN_CAL_ROWS = 6             # below this calibration is unreliable; fall back
_CAL_FRAC = 0.20              # last 20% of training data is calibration
_ALPHA = 0.20                 # 1 - 0.80 = miscoverage target

_QUANTILES = (0.1, 0.5, 0.9)

_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.85,
    min_samples_leaf=5,
    random_state=0,
)


# ---- the strategy ---------------------------------------------------


class ConformalQuantileStrategy(ForecastStrategy):
    """Quantile GBR ensemble with split-conformal calibration."""

    name = "agent_q_conformal"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = build_features(panel)
        y_full = build_target(panel)

        if X_full.empty or y_full.dropna().empty:
            return self._naive(panel, horizon)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                lo, mid, hi = self._predict_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                # Per-horizon fallback: persistence with empirical spread.
                mid = self._last_observed_mom(y_full)
                sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
                spread = _Z80 * sd
                lo = mid - spread
                hi = mid + spread

            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Enforce monotonicity (lo <= mid <= hi). Conformal expansion
            # makes this less likely to fail than raw quantile output but
            # we still sort defensively.
            triple = np.sort(np.array([lo, mid, hi], dtype=float))
            lo_s, mid_s, hi_s = float(triple[0]), float(triple[1]), float(triple[2])

            means[i] = mid_s
            los[i] = lo_s
            his[i] = hi_s

            # Minimum interval width — conformal q_hat can be ~0 if the
            # model fits the calibration set perfectly (rare but possible
            # on very short panels).
            min_half_width = _RESID_FLOOR
            if (his[i] - means[i]) < min_half_width:
                his[i] = means[i] + min_half_width
            if (means[i] - los[i]) < min_half_width:
                los[i] = means[i] - min_half_width

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon: split-conformal calibration around quantile GBR
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train quantile GBRs with conformal calibration; return (lo, mid, hi)."""
        from sklearn.ensemble import GradientBoostingRegressor

        # Build (X_T, y_{T+h}) supervised pairs — direct multi-step.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            spread = _Z80 * sd
            return mid - spread, mid, mid + spread

        # Sort by index so the chronological split is correct. df was
        # built from joined feature/target frames which should already be
        # ordered, but be defensive.
        df = df.sort_index()
        feature_cols = [c for c in df.columns if c != "y_target"]

        n_total = len(df)
        n_cal = max(int(round(n_total * _CAL_FRAC)), _MIN_CAL_ROWS)
        # Make sure proper-train still has enough rows.
        if (n_total - n_cal) < _MIN_TRAIN_ROWS:
            # Not enough to do split conformal — fall back to plain
            # quantile regression on the full data.
            return self._plain_quantile(df, feature_cols, live_row)

        train_df = df.iloc[: n_total - n_cal]
        cal_df = df.iloc[n_total - n_cal :]

        X_train = train_df[feature_cols].values.astype(float)
        y_train = train_df["y_target"].values.astype(float)
        X_cal = cal_df[feature_cols].values.astype(float)
        y_cal = cal_df["y_target"].values.astype(float)

        # Fit on proper-train, predict on calibration set.
        cal_lo: np.ndarray | None = None
        cal_mid: np.ndarray | None = None
        cal_hi: np.ndarray | None = None
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS
            ).fit(X_train, y_train)
            preds_cal = gbr.predict(X_cal).astype(float)
            if q == 0.1:
                cal_lo = preds_cal
            elif q == 0.5:
                cal_mid = preds_cal
            else:
                cal_hi = preds_cal

        if cal_lo is None or cal_mid is None or cal_hi is None:
            return self._plain_quantile(df, feature_cols, live_row)

        # Non-conformity scores for the lo/hi band.
        # r_i = max(yhat_lo - y, y - yhat_hi, 0). Positive when y is
        # outside the band.
        residuals = np.maximum.reduce(
            [cal_lo - y_cal, y_cal - cal_hi, np.zeros_like(y_cal)]
        )

        # Finite-sample-corrected quantile of residuals at level
        # 1 - alpha. Standard split-conformal recipe:
        #   q_hat = ceil((n+1)(1-alpha)) / n -th order statistic
        n_cal_eff = len(residuals)
        level = (np.ceil((n_cal_eff + 1) * (1.0 - _ALPHA))) / n_cal_eff
        level = float(min(max(level, 0.0), 1.0))
        q_hat = float(np.quantile(residuals, level, method="higher"))
        # q_hat should be non-negative by construction.
        q_hat = max(q_hat, 0.0)

        # Median bias correction from calibration residuals (signed).
        median_bias = float(np.mean(y_cal - cal_mid))

        # Re-fit on FULL training data — calibration is done, so use all
        # rows for the actual live prediction.
        X_all = df[feature_cols].values.astype(float)
        y_all = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        live_preds: dict[float, float] = {}
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS
            ).fit(X_all, y_all)
            live_preds[q] = float(gbr.predict(x_live)[0])

        yhat_lo = live_preds[0.1] - q_hat
        yhat_mid = live_preds[0.5] + median_bias
        yhat_hi = live_preds[0.9] + q_hat

        return yhat_lo, yhat_mid, yhat_hi

    # ------------------------------------------------------------------
    # plain quantile regression — used when calibration set would be
    # too small to be meaningful
    # ------------------------------------------------------------------
    def _plain_quantile(
        self,
        df: pd.DataFrame,
        feature_cols: list[str],
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        from sklearn.ensemble import GradientBoostingRegressor

        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        preds: list[float] = []
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS
            ).fit(X, y)
            preds.append(float(gbr.predict(x_live)[0]))
        return preds[0], preds[1], preds[2]

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
    # last-resort fallback: persistence
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = self._last_observed_mom(y)
            sd = max(self._empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
