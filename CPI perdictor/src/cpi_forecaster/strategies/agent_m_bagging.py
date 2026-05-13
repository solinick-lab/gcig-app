"""Agent M: bagging recursive forecasters.

Train MANY (50) Ridge models on bootstrapped subsamples of the training panel
and average their predictions. Bagging reduces variance — a textbook way to
make a single model more robust on small datasets where any single fit can
over-rely on a few observations. Also bag XGBoost the same way and ensemble.

Empirical 80% intervals fall straight out of the bootstrap: we just take the
10th and 90th percentile across the 50 bag predictions per horizon step.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_supervised, build_features


warnings.filterwarnings("ignore")


# ----------------------------- constants -------------------------------

_N_ESTIMATORS = 50
_MAX_SAMPLES = 0.85
_MAX_FEATURES = 0.85
_RIDGE_ALPHA = 1.0
_XGB_N_ESTIMATORS = 200
_XGB_MAX_DEPTH = 3
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_RANDOM_STATE = 0


# ----------------------------- helpers ---------------------------------

def _last_observed_mom(panel: pd.DataFrame) -> float:
    try:
        from ..fred import TARGET
        cpi = panel[TARGET.fred_id]
        s = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = s.dropna()
        if s.empty:
            return 0.0
        return float(s.iloc[-1])
    except Exception:
        return 0.0


def _empirical_mom_std(panel: pd.DataFrame) -> float:
    try:
        from ..fred import TARGET
        cpi = panel[TARGET.fred_id]
        s = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = s.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())
    except Exception:
        return 0.25


def _last_feature_row(panel: pd.DataFrame) -> pd.Series:
    feats = build_features(panel).copy()
    feats = feats.ffill(limit=3)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _roll_cpi_lags(feat_row: pd.Series, yhat: float) -> pd.Series:
    """Recursive update — slide CPI MoM lag1/2/3 forward, freeze macro."""
    out = feat_row.copy()
    if "cpi_mom_lag3" in out and "cpi_mom_lag2" in out:
        out["cpi_mom_lag3"] = out["cpi_mom_lag2"]
    if "cpi_mom_lag2" in out and "cpi_mom_lag1" in out:
        out["cpi_mom_lag2"] = out["cpi_mom_lag1"]
    if "cpi_mom_lag1" in out:
        out["cpi_mom_lag1"] = yhat
    return out


def _per_estimator_predictions(bag, x_row: np.ndarray) -> np.ndarray:
    """Get per-estimator predictions out of a fitted BaggingRegressor.

    Each base estimator was trained on a subset of features (bootstrap_features
    is False here but max_features < 1 still subsamples columns deterministically
    per estimator), so we honour estimators_features_ when calling predict.
    Returns a 1-D array of length n_estimators.
    """
    preds = np.empty(len(bag.estimators_), dtype=float)
    feats_list = getattr(bag, "estimators_features_", None)
    for i, est in enumerate(bag.estimators_):
        try:
            if feats_list is not None:
                cols = feats_list[i]
                preds[i] = float(est.predict(x_row[:, cols])[0])
            else:
                preds[i] = float(est.predict(x_row)[0])
        except Exception:
            preds[i] = np.nan
    return preds


# --------------------------- the strategy ------------------------------

class BaggingStrategy(ForecastStrategy):
    """Bagging Ridge + bagging XGB ensemble with empirical bootstrap intervals."""

    name = "agent_m_bagging"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from sklearn.ensemble import BaggingRegressor
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline

        X, y = build_supervised(panel)
        if X.empty or len(y) < 24:
            return self._naive(panel, horizon)

        feature_cols = list(X.columns)
        X_arr = X.values.astype(float)
        y_arr = y.values.astype(float)

        # ----- Ridge bag -----
        # Pipe the scaler INSIDE the base estimator so each bagged Ridge
        # standardises its own bootstrap sample.
        ridge_base = Pipeline(
            steps=[
                ("scaler", StandardScaler()),
                ("ridge", Ridge(alpha=_RIDGE_ALPHA)),
            ]
        )
        try:
            ridge_bag = BaggingRegressor(
                estimator=ridge_base,
                n_estimators=_N_ESTIMATORS,
                max_samples=_MAX_SAMPLES,
                max_features=_MAX_FEATURES,
                bootstrap=True,
                bootstrap_features=False,
                n_jobs=1,
                random_state=_RANDOM_STATE,
            ).fit(X_arr, y_arr)
        except TypeError:
            # Older sklearn used 'base_estimator' kwarg.
            ridge_bag = BaggingRegressor(
                base_estimator=ridge_base,
                n_estimators=_N_ESTIMATORS,
                max_samples=_MAX_SAMPLES,
                max_features=_MAX_FEATURES,
                bootstrap=True,
                bootstrap_features=False,
                n_jobs=1,
                random_state=_RANDOM_STATE,
            ).fit(X_arr, y_arr)

        # ----- XGB bag (optional — fall back to ridge-only if unavailable) -----
        xgb_bag = None
        try:
            from xgboost import XGBRegressor

            xgb_base = XGBRegressor(
                n_estimators=_XGB_N_ESTIMATORS,
                max_depth=_XGB_MAX_DEPTH,
                learning_rate=0.05,
                subsample=1.0,
                colsample_bytree=1.0,
                objective="reg:squarederror",
                n_jobs=1,
                verbosity=0,
                random_state=_RANDOM_STATE,
            )
            try:
                xgb_bag = BaggingRegressor(
                    estimator=xgb_base,
                    n_estimators=_N_ESTIMATORS,
                    max_samples=_MAX_SAMPLES,
                    max_features=_MAX_FEATURES,
                    bootstrap=True,
                    bootstrap_features=False,
                    n_jobs=1,
                    random_state=_RANDOM_STATE + 1,
                ).fit(X_arr, y_arr)
            except TypeError:
                xgb_bag = BaggingRegressor(
                    base_estimator=xgb_base,
                    n_estimators=_N_ESTIMATORS,
                    max_samples=_MAX_SAMPLES,
                    max_features=_MAX_FEATURES,
                    bootstrap=True,
                    bootstrap_features=False,
                    n_jobs=1,
                    random_state=_RANDOM_STATE + 1,
                ).fit(X_arr, y_arr)
        except Exception:
            xgb_bag = None

        feat_row = _last_feature_row(panel)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for step in range(horizon):
            x_vec = (
                feat_row[feature_cols]
                .values.astype(float)
                .reshape(1, -1)
            )

            ridge_preds = _per_estimator_predictions(ridge_bag, x_vec)
            ridge_preds = ridge_preds[np.isfinite(ridge_preds)]

            if xgb_bag is not None:
                xgb_preds = _per_estimator_predictions(xgb_bag, x_vec)
                xgb_preds = xgb_preds[np.isfinite(xgb_preds)]
            else:
                xgb_preds = np.array([], dtype=float)

            # 50/50 ensemble of bagged-Ridge and bagged-XGB means.
            r_mean = float(np.mean(ridge_preds)) if ridge_preds.size else _last_observed_mom(panel)
            if xgb_preds.size:
                x_mean = float(np.mean(xgb_preds))
                yhat = 0.5 * r_mean + 0.5 * x_mean
                # Pool the per-bag predictions for the empirical interval —
                # if both bags exist, average the two distributions
                # element-wise so the pool reflects the 50/50 ensemble.
                m = min(ridge_preds.size, xgb_preds.size)
                pooled = 0.5 * ridge_preds[:m] + 0.5 * xgb_preds[:m]
            else:
                yhat = r_mean
                pooled = ridge_preds

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))

            if pooled.size >= 5:
                lo = float(np.percentile(pooled, 10.0))
                hi = float(np.percentile(pooled, 90.0))
                # Guard against pathologically tight intervals.
                spread = max(hi - lo, 2.0 * _RESID_FLOOR)
                centre = 0.5 * (hi + lo)
                lo = centre - 0.5 * spread
                hi = centre + 0.5 * spread
                # Re-anchor the interval on the ensemble mean.
                lo = yhat - max(yhat - lo, _RESID_FLOOR)
                hi = yhat + max(hi - yhat, _RESID_FLOOR)
            else:
                sd = max(_empirical_mom_std(panel), _RESID_FLOOR)
                lo = yhat - 1.2816 * sd
                hi = yhat + 1.2816 * sd

            means[step] = yhat
            los[step] = lo
            his[step] = hi

            # Recursive roll: slot yhat into cpi_mom_lag1, slide lag2/3.
            feat_row = _roll_cpi_lags(feat_row, yhat)

        return means, los, his

    # -------------------------- last-resort fallback ----------------------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = 1.2816 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
