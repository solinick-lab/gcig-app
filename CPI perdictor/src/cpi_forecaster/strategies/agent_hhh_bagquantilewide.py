"""Agent HHH — Bagged quantile regression on the WIDE panel (round 5).

Round-5 angle: combine BAGGING (variance reduction) with QUANTILE LOSS
(robustness to heavy-tailed CPI residuals) on the FULL expanded feature
matrix. The original quantile winner (agent_g_quantile) was trained on
build_features when FEATURES had only 14 series; agent_v_bootquantile
demonstrated that bagging + quantile aggregation works on the same
narrow base. This strategy runs that same bag-quantile pattern on top
of the wide ~37-series panel so the variance-reducing ensemble has the
fuller information set (TIPS breakevens, Cleveland median / Atlanta
sticky CPI, yield-curve spreads, HY credit, JOLTS, sentiment, PCE,
housing leading indicators, Brent / diesel, capacity utilization,
industrial commodities) to draw on.

Pipeline:
  1. Build wide feature matrix via build_features (which already
     iterates over the full FEATURES tuple — MoM lag1, 3mo lag1, YoY
     lag1 per series). The "MoM + YoY lag1 each" the spec calls for
     is therefore satisfied by the existing builder; 3mo lag1 comes
     along as a bonus and helps stability.
  2. Per horizon h ∈ {1, 2, 3}: train 30 GradientBoostingRegressor
     quantile-loss models (alpha=0.5) with n_estimators=150,
     max_depth=3, learning_rate=0.05 on 85% bootstrap subsamples.
     Each fit gets a different seed so the trees vary across bags.
  3. Aggregate: median across the 30 bag predictions = mean output;
     10th / 90th percentiles = lo80 / hi80.
  4. Direct multi-step: independent (X_T, y_{T+h}) supervised fit per
     horizon — no recursive feeding.

Speed budget: 30 bags * 150 trees * 3 horizons keeps each cut under the
60s/cut rule. The final wide quantile-bagging strategy ends up doing
roughly the same total work as agent_v_bootquantile (50*200=10k trees
per horizon vs 30*150=4.5k here), but each bag sees a wider X so the
per-tree splits are richer.

Defensive: fit_and_predict is wrapped in try/except. Per-horizon
failures fall back to persistence with empirical MoM std for the band.
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

_N_BAGS = 30                  # number of bootstrap GBR fits per horizon
_BAG_FRAC = 0.85              # bootstrap subsample size as fraction of train
_RANDOM_STATE = 0

# Per spec: alpha=0.5 (median quantile loss), n_estimators=150,
# max_depth=3, lr=0.05. Slightly lighter than agent_v_bootquantile's
# 200 trees x 50 bags so the wider X doesn't blow the per-cut budget.
_GBR_PARAMS = dict(
    loss="quantile",
    alpha=0.5,
    n_estimators=150,
    max_depth=3,
    learning_rate=0.05,
    min_samples_leaf=5,
)


# ---- the strategy ---------------------------------------------------


class BagQuantileWideStrategy(ForecastStrategy):
    """30-bag quantile-loss GBR ensemble on the wide feature panel."""

    name = "agent_hhh_bagquantilewide"

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
        # build_features already spans the entire expanded FEATURES
        # tuple (TIPS breakevens, Cleveland CPI variants, Atlanta sticky
        # CPI, yield curve, HY credit spreads, JOLTS, sentiment, PCE,
        # housing, Brent, diesel, capacity, industrial commodities), so
        # the "wide" panel is automatic.
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
    # per-horizon: 30 bootstrapped quantile-loss GBRs, aggregate
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train 30 bagged quantile GBRs and return (lo10, median, hi90)."""
        from sklearn.ensemble import GradientBoostingRegressor

        # Direct multi-step alignment: X at T predicts y at T+h.
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
        x_live = (
            live_row.reindex(feature_cols)
            .astype(float)
            .values.reshape(1, -1)
        )
        # Defensive zero-fill for any straggler NaNs in the live row
        # (the wide panel's looser-publication series — JOLTS, housing
        # — can otherwise lose us the row).
        x_live = np.nan_to_num(x_live, nan=0.0, posinf=0.0, neginf=0.0)

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
        """Most recent feature row at the cut date, with tiny ffill.

        The wide panel includes series with looser publication lags
        (JOLTS, housing starts, sentiment) so a couple of forward-fills
        keep us from dropping the live row over a single missing cell.
        """
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        # Don't dropna(how="any") here — the wide panel virtually
        # guarantees at least one straggler. We rely on the per-horizon
        # nan_to_num on x_live to stabilize prediction.
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
