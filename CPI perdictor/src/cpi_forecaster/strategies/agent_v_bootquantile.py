"""Agent V: bootstrap quantile aggregation.

Bagging + quantile loss combined. For each horizon h we fit MANY (50)
GradientBoostingRegressor models with loss='quantile', alpha=0.5 on
bootstrapped 85% subsamples of the training panel. Each fit gets its
own seed so the trees vary across bags.

Aggregation:
  mean  = median across the 50 bag predictions (robust central forecast)
  lo80  = 10th percentile across bags (empirical bootstrap interval)
  hi80  = 90th percentile across bags

Two known-good techniques stacked: bagging shrinks variance, quantile
(pinball) loss is robust to heavy-tailed residuals. Bands fall out of
the bootstrap distribution directly — no Gaussian assumption.

Direct multi-step: independent per-horizon (X_T, y_{T+h}) supervised fit.
n_estimators per GBR is held to 200 (vs Agent G's 300) because 50 fits
per horizon is the budget pressure point for the <30s/cut rule.

Defensive: fit_and_predict is wrapped in try/except. If bagging fails
we fall back to a last-observed-MoM persistence forecast with empirical
spread.
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
_MIN_TRAIN_ROWS = 36          # below this we don't fit GBRs

_N_BAGS = 50                  # number of bootstrap GBR fits per horizon
_BAG_FRAC = 0.85              # bootstrap subsample size as fraction of train
_RANDOM_STATE = 0

_GBR_PARAMS = dict(
    loss="quantile",
    alpha=0.5,
    n_estimators=200,         # modest — 50 of them adds up
    max_depth=3,
    learning_rate=0.05,
    min_samples_leaf=5,
)


# ---- the strategy ---------------------------------------------------


class BootstrapQuantileStrategy(ForecastStrategy):
    """50-bag quantile-loss GBR ensemble with empirical bootstrap intervals."""

    name = "agent_v_bootquantile"

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

            # Floor interval width — pad if the bag distribution
            # collapsed onto the median (e.g. boring flat region).
            if (hi - mid) < _RESID_FLOOR:
                hi = mid + _RESID_FLOOR
            if (mid - lo) < _RESID_FLOOR:
                lo = mid - _RESID_FLOOR

            means[i] = mid
            los[i] = lo
            his[i] = hi

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon: 50 bootstrapped quantile-loss GBRs, aggregate
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train 50 bagged quantile GBRs and return (lo10, median, hi90)."""
        from sklearn.ensemble import GradientBoostingRegressor

        # Build (X_T, y_{T+h}) — direct multi-step alignment.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            spread = _Z80 * sd
            return mid - spread, mid, mid + spread

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        n = len(y)
        bag_size = max(_MIN_TRAIN_ROWS // 2, int(np.floor(_BAG_FRAC * n)))

        # Per-horizon RNG so bags vary across both horizon and bag index,
        # but the run as a whole is deterministic (reproducible).
        rng = np.random.default_rng(_RANDOM_STATE + 1000 * h)

        preds = np.empty(_N_BAGS, dtype=float)
        for b in range(_N_BAGS):
            idx = rng.choice(n, size=bag_size, replace=True)
            Xb = X[idx]
            yb = y[idx]
            try:
                gbr = GradientBoostingRegressor(
                    random_state=int(rng.integers(0, 2**31 - 1)),
                    **_GBR_PARAMS,
                ).fit(Xb, yb)
                preds[b] = float(gbr.predict(x_live)[0])
            except Exception:
                preds[b] = np.nan

        good = preds[np.isfinite(preds)]
        if good.size < 5:
            # Bag mostly failed — punt to persistence.
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            spread = _Z80 * sd
            return mid - spread, mid, mid + spread

        median = float(np.median(good))
        lo = float(np.percentile(good, 10.0))
        hi = float(np.percentile(good, 90.0))

        # Re-anchor the interval on the median so the point forecast
        # always lies inside the band, even if percentile asymmetry
        # placed it outside.
        if lo > median:
            lo = median - _RESID_FLOOR
        if hi < median:
            hi = median + _RESID_FLOOR

        return lo, median, hi

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
