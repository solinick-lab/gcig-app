"""Quantile regression on the EXPANDED feature panel.

Round-5 angle for agent BBB. The current quantile winner
(agent_g_quantile) was trained back when build_features only knew
about the original 14 macro series. The FEATURES tuple in fred.py has
since been expanded to 37 series — adding inflation expectations
(T5YIE, T10YIE), alternative inflation measures (Cleveland Fed median,
Atlanta Fed sticky CPI), yield-curve / policy signals (T10Y2Y), credit
spreads (BAMLH0A0HYM2), labor depth (JTSJOL), consumer sentiment
(UMCSENT), PCE (PCEPI), housing leading indicators (HOUST), capacity
utilization (TCU), and Brent crude (DCOILBRENTEU), among others.

The bet is simple: same architecture, more signal. Three quantile-loss
GradientBoostingRegressor models per horizon (alpha = 0.1, 0.5, 0.9),
direct multi-step alignment, post-hoc sort to fix quantile crossing,
sanity clip on the central forecast.

Because build_features in this repo already iterates over the full
FEATURES tuple (not the old 14-only subset), calling build_features
here automatically pulls in MoM-lag1 and YoY-lag1 for every new
series. We therefore inherit the expanded panel for free — no manual
feature stitching required.

Defensive: fit_and_predict is wrapped in try/except. If the GBR fit
fails on any horizon we fall back to a last-observed-MoM persistence
forecast with empirical-std-derived 80% intervals.
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
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity clip on means)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity clip on means)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MIN_TRAIN_ROWS = 36          # below this we don't fit the GBR

_QUANTILES = (0.1, 0.5, 0.9)

# Per spec: n_estimators=300, max_depth=3, lr=0.05.
_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.85,
    min_samples_leaf=5,
    random_state=0,
)


# ---- the strategy ---------------------------------------------------


class QuantileWideStrategy(ForecastStrategy):
    """Direct multi-step quantile GBR (q=0.1, 0.5, 0.9) on the wide panel."""

    name = "agent_bbb_quantilewide"

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
        # build_features now spans all 37 FEATURES (MoM+3mo+YoY each),
        # so the "wide panel" is automatic.
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

            # Sanity-clip the central forecast.
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Sort to fix quantile crossing — separately-trained
            # quantile regressors can violate q0.1 < q0.5 < q0.9
            # especially with smaller training windows / wider panels.
            triple = np.sort(np.array([lo, mid, hi], dtype=float))
            lo_s, mid_s, hi_s = float(triple[0]), float(triple[1]), float(triple[2])

            means[i] = mid_s
            los[i] = lo_s
            his[i] = hi_s

            # Guarantee a minimum interval half-width on each side.
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

        # Direct multi-step: line up X at T with y at T+h.
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

        preds: list[float] = []
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS
            ).fit(X, y)
            preds.append(float(gbr.predict(x_live)[0]))

        # [q=0.1, q=0.5, q=0.9] in order — caller sorts again for safety.
        return preds[0], preds[1], preds[2]

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        """Most recent feature row at the cut date, with tiny ffill.

        The wide panel introduces series with looser publication lags
        (e.g. JOLTS, housing starts) so a couple of forward-fills here
        keep us from dropping the live row over a single missing cell.
        """
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
