"""Median CPI strategy.

Cleveland Fed publishes a median CPI (MEDCPIM158SFRBCLE) and a 16% trimmed
mean CPI (TRMMEANCPIM158SFRBCLE). Both strip out outlier components every
month. Median CPI is well known to lead headline CPI's persistent component
by a few months — when the underlying basket median bends, headline tends
to follow once transitory food/energy noise washes out.

This strategy:
  1. Adds median CPI + trimmed mean CPI MoM, 3-month, and YoY change
     features (lagged, no leakage).
  2. Adds an explicit "noise component" feature: headline_yoy - median_yoy.
     If headline is well above the median, recent prints are dominated by
     a few outlier categories that should mean-revert, dragging the
     headline back toward the median.
  3. Trains direct multi-step Ridge + XGBoost on the headline target.
  4. Optional second pass: trains the same architecture on a median-CPI
     target, then blends headline_pred with (median_pred + historical
     headline-minus-median spread) using a 70/30 weighting. The blend
     dampens noisy headline forecasts during regime shifts where median
     gives a steadier signal.

If neither median nor trimmed mean is in the panel, fall back to the
direct strategy on the standard feature set.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target, _log_mom, _mom, _yoy
from ..fred import TARGET


warnings.filterwarnings("ignore")


MEDIAN_ID = "MEDCPIM158SFRBCLE"
TRIMMEAN_ID = "TRMMEANCPIM158SFRBCLE"


class MedianCpiStrategy(ForecastStrategy):
    name = "agent_gg_median"

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

    # Blend weights: headline-direct gets the lion's share; the
    # median-anchored estimate is a stabilizer, not a primary signal.
    _W_HEADLINE = 0.7
    _W_MEDIAN_PATH = 0.3

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
        have_median = MEDIAN_ID in panel.columns and panel[MEDIAN_ID].notna().sum() > 36
        have_trim = TRIMMEAN_ID in panel.columns and panel[TRIMMEAN_ID].notna().sum() > 36

        # Build feature matrix: standard build_features + median/trimmean lags + spread.
        X_full = self._build_extended_features(panel, have_median, have_trim)
        y_full = build_target(panel)

        # Median-CPI MoM target (used by the optional second-path forecast).
        y_median: pd.Series | None = None
        if have_median:
            y_median = _log_mom(panel[MEDIAN_ID]).rename("y_median_mom")

        live_row = self._latest_feature_row(X_full)

        # Historical mean of (headline_mom - median_mom) — this is the
        # "noise correction" we add to the median-path forecast so it is
        # roughly in headline space.
        spread_mean = 0.0
        if y_median is not None:
            both = y_full.to_frame("h").join(y_median.rename("m"), how="inner").dropna()
            if len(both) >= 60:
                # Use the last ~10 years to avoid stale 1990s spreads.
                tail = both.tail(120)
                spread_mean = float((tail["h"] - tail["m"]).mean())

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                head_pred, head_resid_std = self._fit_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                head_pred = self._last_observed_mom(y_full)
                head_resid_std = max(self._empirical_mom_std(y_full), 0.15)

            # Optional median-path blend.
            if y_median is not None:
                try:
                    med_pred, _ = self._fit_one_horizon(
                        X_full, y_median, h, live_row
                    )
                    # Convert median-MoM forecast into a headline-MoM forecast
                    # by adding the historical headline-minus-median spread.
                    med_path = med_pred + spread_mean
                    yhat = (
                        self._W_HEADLINE * head_pred
                        + self._W_MEDIAN_PATH * med_path
                    )
                except Exception:
                    yhat = head_pred
            else:
                yhat = head_pred

            spread = self._Z80 * head_resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # feature construction
    # ------------------------------------------------------------------
    def _build_extended_features(
        self, panel: pd.DataFrame, have_median: bool, have_trim: bool
    ) -> pd.DataFrame:
        X = build_features(panel)

        extras: dict[str, pd.Series] = {}

        if have_median:
            med = panel[MEDIAN_ID]
            extras["medcpi_mom_lag1"] = _mom(med).shift(1)
            extras["medcpi_mom_lag2"] = _mom(med).shift(2)
            extras["medcpi_3mo_lag1"] = ((med / med.shift(3) - 1.0) * 100.0).shift(1)
            extras["medcpi_yoy_lag1"] = _yoy(med).shift(1)
            extras["medcpi_yoy_lag3"] = _yoy(med).shift(3)

        if have_trim:
            trm = panel[TRIMMEAN_ID]
            extras["trmcpi_mom_lag1"] = _mom(trm).shift(1)
            extras["trmcpi_mom_lag2"] = _mom(trm).shift(2)
            extras["trmcpi_3mo_lag1"] = ((trm / trm.shift(3) - 1.0) * 100.0).shift(1)
            extras["trmcpi_yoy_lag1"] = _yoy(trm).shift(1)

        # Headline-vs-median noise component: positive when headline is
        # running hot relative to the underlying-basket median (typically
        # food/energy or a few outlier categories), negative when cool.
        if have_median:
            cpi = panel[TARGET.fred_id]
            spread_yoy = (_yoy(cpi) - _yoy(panel[MEDIAN_ID])).shift(1)
            extras["noise_component_yoy_lag1"] = spread_yoy
            extras["noise_component_yoy_lag3"] = spread_yoy.shift(2)

        if have_median and have_trim:
            # Median-vs-trimmean: rarely far apart; when it widens, the
            # tails are unusually fat — useful regime indicator.
            extras["med_minus_trim_yoy_lag1"] = (
                _yoy(panel[MEDIAN_ID]) - _yoy(panel[TRIMMEAN_ID])
            ).shift(1)

        if extras:
            extra_df = pd.concat(extras, axis=1)
            X = X.join(extra_df, how="left")

        return X

    # ------------------------------------------------------------------
    # per-horizon ensemble fit
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

        # Live row may be missing some of the new median-derived columns
        # if the panel didn't actually have those series; we already
        # gated on that in _build_extended_features, so live_row should
        # contain every feature_col by construction. Be defensive anyway.
        live_vals = []
        for c in feature_cols:
            v = live_row.get(c, np.nan)
            live_vals.append(v if pd.notna(v) else 0.0)
        x_live = np.asarray(live_vals, dtype=float).reshape(1, -1)

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
        # Some median/trimmean lag columns can have NaN at the very edge
        # if Cleveland Fed releases late. Backfill those one column at a
        # time with their column mean rather than dropping the row.
        feats = feats.fillna(feats.mean(numeric_only=True))
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
