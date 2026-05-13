"""Agent O — Local / analog method.

Old-school weather forecasting trick: for each forecast, find the K most
similar past macro states (in standardized feature space) and forecast as
a kernel-weighted average of what happened next. Naturally regime-aware:
it implicitly down-weights observations from a different regime than the
current one.

To stabilize on a small monthly panel we ensemble the analog (KNN with
distance weighting) with a Ridge model on the same features (50/50). Pure
KNN can be wobbly when the live state is in a sparse part of feature
space.

For each horizon h in 1..H we train a separate (X_T, y_{T+h}) supervised
pair (direct multi-step), so there is no recursive error compounding.

Forecast intervals: 80% intervals come from the *local* empirical
distribution of the K nearest neighbors' actual outcomes (10th and 90th
percentile). Floor against the global residual std so the band can't
collapse on tight matches.

Per the race contract, fit_and_predict NEVER raises — wrapped in nested
try/except with a Ridge-only fallback and ultimately a persistence
fallback.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ---- constants ----
_K_NEIGHBORS = 20
_BLEND_W = 0.5            # 0.5 = 50/50 KNN + Ridge
_Z80 = 1.2816             # one-sided z for 80% interval (fallback only)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36

# Features whose recent dynamics carry the most CPI signal — bumped 1.5x
# in scaled space so they dominate the analog distance metric. Anything
# with "cpi_mom_lag" or "cpi_yoy_lag" is core; oil/gas momentum and the
# expectations level matter too. Everything else stays at weight 1.
_BOOST_PATTERNS = (
    "cpi_mom_lag",
    "cpi_yoy_lag",
    "DCOILWTICO_mom_lag",
    "GASREGW_mom_lag",
    "MICH_mom_lag",
)
_BOOST_WEIGHT = 1.5


def _feature_weights(feature_cols: list[str]) -> np.ndarray:
    w = np.ones(len(feature_cols), dtype=float)
    for i, c in enumerate(feature_cols):
        for pat in _BOOST_PATTERNS:
            if pat in c:
                w[i] = _BOOST_WEIGHT
                break
    return w


def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    feats = X_full.copy()
    feats = feats.ffill(limit=2)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _last_observed_mom(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())


class AnalogStrategy(ForecastStrategy):
    """KNN analog forecaster blended 50/50 with Ridge on same features."""

    name = "agent_o_analog"

    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)

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

        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, lo, hi = self._predict_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                # Per-horizon fallback: persistence + global vol band.
                yhat = _last_observed_mom(y_full)
                std = max(_empirical_mom_std(y_full), 0.15)
                spread = _Z80 * std
                lo = yhat - spread
                hi = yhat + spread

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            # Clip the band ends as well so they don't drift to absurd
            # values during regime-shift cuts.
            lo = float(np.clip(lo, _MOM_LO_CLIP - 0.5, _MOM_HI_CLIP + 0.5))
            hi = float(np.clip(hi, _MOM_LO_CLIP - 0.5, _MOM_HI_CLIP + 0.5))
            # Make sure lo <= yhat <= hi even after numerical jitter.
            lo = min(lo, yhat - _RESID_FLOOR * _Z80 * 0.5)
            hi = max(hi, yhat + _RESID_FLOOR * _Z80 * 0.5)

            means[i] = yhat
            los[i] = lo
            his[i] = hi

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon analog + ridge ensemble
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Train KNN + Ridge on (X_T, y_{T+h}) and return (yhat, lo80, hi80)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.neighbors import KNeighborsRegressor

        # Build the (X_T, y_{T+h}) supervised pair.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            yhat = _last_observed_mom(y_full)
            std = max(_empirical_mom_std(y_full), 0.15)
            spread = _Z80 * std
            return yhat, yhat - spread, yhat + spread

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Scale on TRAINING data only (no peek at the live row's scale).
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        # Apply per-feature weights on the standardized space — these
        # multiply distances along the boosted axes so the analog metric
        # privileges them.
        w = _feature_weights(feature_cols)
        Xs_w = Xs * w
        x_live_s_w = x_live_s * w

        # ---- KNN analog ----
        # Cap K at the number of training rows to be safe on tiny panels.
        k = min(_K_NEIGHBORS, max(3, len(df) - 1))
        knn = KNeighborsRegressor(
            n_neighbors=k, weights="distance", algorithm="auto"
        ).fit(Xs_w, y)
        knn_pred = float(knn.predict(x_live_s_w)[0])

        # Local empirical distribution — pull the K nearest neighbors'
        # actual outcomes for the interval.
        try:
            _, nn_idx = knn.kneighbors(x_live_s_w, n_neighbors=k)
            nn_outcomes = y[nn_idx[0]]
        except Exception:
            nn_outcomes = None

        # ---- Ridge anchor ----
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
        ridge_pred = float(ridge.predict(x_live_s)[0])

        # ---- 50/50 blend ----
        if not np.isfinite(knn_pred):
            yhat = ridge_pred
        elif not np.isfinite(ridge_pred):
            yhat = knn_pred
        else:
            yhat = _BLEND_W * knn_pred + (1.0 - _BLEND_W) * ridge_pred

        # ---- 80% interval from local empirical distribution ----
        if nn_outcomes is not None and len(nn_outcomes) >= 5:
            lo_local = float(np.percentile(nn_outcomes, 10.0))
            hi_local = float(np.percentile(nn_outcomes, 90.0))
            # Re-center the local band on the blended yhat — keeps the
            # interval honest when the blend pulls yhat away from the
            # KNN center.
            local_center = float(np.mean(nn_outcomes))
            lo = yhat + (lo_local - local_center)
            hi = yhat + (hi_local - local_center)
            # Floor the half-width so a too-tight cluster doesn't collapse.
            half = max((hi - lo) / 2.0, _Z80 * _RESID_FLOOR)
            lo = yhat - half
            hi = yhat + half
        else:
            # Fall back to global residual std of the blend.
            ridge_resid = y - ridge.predict(Xs)
            std = float(np.std(ridge_resid))
            std = max(std, _RESID_FLOOR)
            spread = _Z80 * std
            lo = yhat - spread
            hi = yhat + spread

        return yhat, lo, hi

    # ------------------------------------------------------------------
    # whole-strategy fallback if everything blows up
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = _last_observed_mom(y)
            sd = max(_empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
