"""Quantile regression ensemble.

Most CPI strategies in this race forecast a conditional MEAN and then
slap a Gaussian-derived spread on top — the lo80 / hi80 are mean +/-
1.2816 * sigma where sigma is the training-residual standard deviation.
That is fine if errors really are normal, but the empirical CPI MoM
distribution has heavy tails and asymmetric skew (especially around
energy shocks). The point forecast also drifts with the mean rather
than tracking the conditional MEDIAN, which is more robust.

This strategy fits the conditional QUANTILES directly via gradient
boosting with the pinball ('quantile') loss. For each horizon h we
train three independent GradientBoostingRegressor models with
alpha in {0.1, 0.5, 0.9} on the (X_T, y_{T+h}) supervised pair —
direct multi-step, no recursive feedback. Inference is then:

    mean  = q=0.5 prediction (conditional median)
    lo80  = q=0.1 prediction
    hi80  = q=0.9 prediction

Quantile crossing (lo80 > hi80, or median outside the band) is a
known issue with separately-trained quantile regressors. We sort the
three predictions per horizon to enforce monotonicity post-hoc.

Defensive: fit_and_predict is wrapped in try/except. If GBR fitting
fails we fall back to a last-observed-MoM persistence forecast with
empirical-std-derived intervals.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


# Suppress noisy convergence / future warnings from sklearn.
warnings.filterwarnings("ignore")


# ---- constants ------------------------------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval (fallback only)
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MIN_TRAIN_ROWS = 36          # below this we don't fit the GBR

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


class QuantileRegressionStrategy(ForecastStrategy):
    """Direct multi-step quantile regression ensemble (q=0.1, 0.5, 0.9)."""

    name = "agent_g_quantile"

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

            # Clip the central forecast for sanity.
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Enforce monotonicity (lo80 < mean < hi80) by sorting the
            # triple. Quantile crossing happens with separately-trained
            # quantile models, especially at small training sizes.
            triple = np.sort(np.array([lo, mid, hi], dtype=float))
            lo_s, mid_s, hi_s = float(triple[0]), float(triple[1]), float(triple[2])

            # The median (q=0.5) is the point forecast. If sorting moved
            # it, keep the sorted-middle value as the mean — this avoids
            # the absurd case of mean outside the interval.
            means[i] = mid_s
            los[i] = lo_s
            his[i] = hi_s

            # Guarantee a minimum interval width: if the three quantile
            # predictions collapse onto the median (rare but possible
            # with strongly-regularised GBR on a flat region), pad.
            min_half_width = _RESID_FLOOR
            if (his[i] - means[i]) < min_half_width:
                his[i] = means[i] + min_half_width
            if (means[i] - los[i]) < min_half_width:
                los[i] = means[i] - min_half_width

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon: fit three GBRs, predict three quantiles
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train three quantile-loss GBRs and return (lo, mid, hi)."""
        from sklearn.ensemble import GradientBoostingRegressor

        # Build (X_T, y_{T+h}) — direct multi-step alignment.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            # Not enough rows to fit a GBR sensibly; fall through.
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            spread = _Z80 * sd
            return mid - spread, mid, mid + spread

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        preds: list[float] = []
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS
            ).fit(X, y)
            preds.append(float(gbr.predict(x_live)[0]))

        # preds is [q=0.1, q=0.5, q=0.9] in order — caller sorts for safety.
        return preds[0], preds[1], preds[2]

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        """Most recent feature row at the cut date, with tiny ffill."""
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
