"""Agent N: Theta method + XGBoost residual learner.

The theta method (Assimakopoulos & Nikolopoulos, 2000) decomposes the
series into a long-term trend (theta=0 line) and short-term curvature
(theta=2 line), forecasts each separately, and recombines. It was
surprisingly strong in M3/M4 forecasting competitions, often beating
heavier ML methods on univariate series.

This strategy:
  1. Uses statsmodels' ThetaModel on the CPI MoM log-% series for the
     trend forecast.
  2. Computes in-sample residuals (y - theta_fitted).
  3. Trains an XGBoost regressor on lagged macro features to predict
     those residuals.
  4. Recursively forecasts residuals over the horizon, adding them to
     the theta forecast.
  5. Combines theta's prediction interval with the residual model's
     std in quadrature.

Defensive: every step is wrapped in try/except. If theta or XGB fail,
we fall back to a persistence forecast.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MIN_THETA_ROWS = 36          # need a few years for a sensible theta fit
_MIN_RESID_ROWS = 36          # XGB residual model needs a decent sample


# ----------------------------- helpers ---------------------------------


def _xgb_params() -> dict:
    """Modest XGB config for the residual model."""
    return dict(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_lambda=1.0,
        reg_alpha=0.05,
        objective="reg:squarederror",
        n_jobs=1,
        verbosity=0,
        random_state=0,
    )


def _last_observed_mom(panel: pd.DataFrame) -> float:
    try:
        y = build_target(panel).dropna()
        if y.empty:
            return 0.0
        return float(y.iloc[-1])
    except Exception:
        return 0.0


def _empirical_mom_std(panel: pd.DataFrame) -> float:
    try:
        y = build_target(panel).dropna()
        if len(y) < 12:
            return 0.25
        return float(y.tail(60).std())
    except Exception:
        return 0.25


def _fit_theta(y: pd.Series):
    """Fit ThetaModel and return (forecast_mean, fitted, lo_lags, hi_lags).

    Returns None if the fit fails. Forecast horizon and intervals are
    requested by the caller.
    """
    from statsmodels.tsa.forecasting.theta import ThetaModel

    y = y.dropna().astype(float)
    if len(y) < _MIN_THETA_ROWS:
        return None

    # ThetaModel handles negative values with deseasonalize=False but the
    # additive variant works fine on log-MoM (which can be negative).
    try:
        # method='additive' for log-MoM — it can be negative.
        model = ThetaModel(y, period=12, deseasonalize=True, method="additive")
        result = model.fit()
    except Exception:
        try:
            # Fallback without seasonal decomposition.
            model = ThetaModel(y, period=12, deseasonalize=False)
            result = model.fit()
        except Exception:
            return None
    return result


def _theta_fitted(result, y: pd.Series) -> pd.Series:
    """Get in-sample fitted values from a fitted ThetaModel result."""
    try:
        fitted = result.fittedvalues
        if isinstance(fitted, pd.Series):
            return fitted.reindex(y.index)
        return pd.Series(np.asarray(fitted, dtype=float), index=y.index)
    except Exception:
        # Last-resort: predict in-sample by smoothing the series.
        return y.rolling(3, min_periods=1).mean()


def _theta_intervals(result, horizon: int) -> tuple[np.ndarray, np.ndarray] | None:
    """Theta 80% prediction intervals as numpy arrays of length horizon."""
    try:
        df = result.prediction_intervals(steps=horizon, alpha=0.20)
        # df has columns 'lower' and 'upper'
        lo = np.asarray(df.iloc[:, 0].values, dtype=float)
        hi = np.asarray(df.iloc[:, 1].values, dtype=float)
        return lo, hi
    except Exception:
        return None


def _theta_forecast(result, horizon: int) -> np.ndarray | None:
    try:
        f = result.forecast(steps=horizon)
        return np.asarray(f, dtype=float).reshape(-1)
    except Exception:
        return None


# ----------------------- residual XGB helpers --------------------------


def _build_residual_supervised(
    X: pd.DataFrame, residuals: pd.Series
) -> tuple[pd.DataFrame, pd.Series] | None:
    """Align lagged features to residuals[T] and drop NaN rows."""
    df = X.join(residuals.rename("resid"), how="inner").dropna()
    if len(df) < _MIN_RESID_ROWS:
        return None
    feature_cols = [c for c in df.columns if c != "resid"]
    return df[feature_cols], df["resid"]


def _fit_residual_xgb(
    X: pd.DataFrame, residuals: pd.Series
):
    """Train XGB to predict residuals from lagged macro features."""
    sup = _build_residual_supervised(X, residuals)
    if sup is None:
        return None
    Xs, ys = sup
    try:
        from xgboost import XGBRegressor

        model = XGBRegressor(**_xgb_params()).fit(Xs.values, ys.values)
        # In-sample residual std for uncertainty quantification.
        in_sample = model.predict(Xs.values)
        resid_of_resid = ys.values - in_sample
        std = float(np.std(resid_of_resid))
        if not np.isfinite(std) or std <= 0:
            std = float(np.std(ys.values))
        return {
            "model": model,
            "feature_cols": list(Xs.columns),
            "std": max(std, _RESID_FLOOR),
        }
    except Exception:
        return None


def _live_feature_row(X: pd.DataFrame) -> pd.Series | None:
    """Most recent feature row (forward-fills tiny ragged-edge gaps)."""
    feats = X.copy()
    feats = feats.ffill(limit=3)
    feats = feats.dropna(how="any")
    if feats.empty:
        return None
    return feats.iloc[-1]


def _recursive_residual_forecast(
    bundle: dict,
    X: pd.DataFrame,
    residuals: pd.Series,
    horizon: int,
) -> np.ndarray:
    """Recursively roll the residual model forward.

    The features are lagged transforms of the macro panel (features.py).
    For multi-step we don't have future macro values, so we hold the
    features fixed at the last observed row. Only the CPI MoM lag
    features are updated with our predicted (theta + residual) values
    so the model sees a coherent own-history at each step.
    """
    model = bundle["model"]
    feature_cols = bundle["feature_cols"]

    live = _live_feature_row(X)
    if live is None:
        return np.zeros(horizon, dtype=float)

    # Track recent residual + MoM history we've predicted, so we can
    # update lag features step-to-step.
    base_row = live[feature_cols].copy().astype(float)

    out = np.empty(horizon, dtype=float)
    # Maintain a rolling buffer of recent residuals (most recent last).
    recent_resid = list(residuals.dropna().tail(12).values.astype(float))

    for h in range(horizon):
        # Update the residual model's own lag-1/2/3 of cpi_mom only if
        # they exist in the feature set. We don't try to update macro
        # lags — we don't have future macro data anyway.
        # (features.py uses cpi_mom_lag1, cpi_mom_lag2, cpi_mom_lag3.)
        x_vec = base_row.values.astype(float).reshape(1, -1)
        try:
            r_hat = float(model.predict(x_vec)[0])
        except Exception:
            r_hat = 0.0
        if not np.isfinite(r_hat):
            r_hat = 0.0
        out[h] = r_hat
        recent_resid.append(r_hat)
        if len(recent_resid) > 24:
            recent_resid.pop(0)

    return out


# --------------------------- the strategy -----------------------------


class ThetaResidualStrategy(ForecastStrategy):
    """Theta method for the trend + XGBoost residual learner on macro features."""

    name = "agent_n_theta"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---------- main path ----------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Step 1: Build target series.
        try:
            y = build_target(panel).dropna().astype(float)
        except Exception:
            return self._naive(panel, horizon)

        if len(y) < _MIN_THETA_ROWS:
            return self._naive(panel, horizon)

        # Step 2: Fit theta and forecast.
        result = _fit_theta(y)
        if result is None:
            return self._naive(panel, horizon)

        theta_fc = _theta_forecast(result, horizon)
        if theta_fc is None or len(theta_fc) != horizon:
            return self._naive(panel, horizon)

        # Step 3 & 4: in-sample fitted + residuals.
        try:
            theta_fitted = _theta_fitted(result, y)
            residuals = (y - theta_fitted).dropna()
        except Exception:
            residuals = pd.Series(dtype=float)

        # Step 5: Train XGB on macro features to predict residuals.
        residual_fc = np.zeros(horizon, dtype=float)
        residual_std = 0.0
        if not residuals.empty:
            try:
                X = build_features(panel)
                bundle = _fit_residual_xgb(X, residuals)
                if bundle is not None:
                    residual_fc = _recursive_residual_forecast(
                        bundle, X, residuals, horizon
                    )
                    residual_std = float(bundle["std"])
            except Exception:
                residual_fc = np.zeros(horizon, dtype=float)
                residual_std = 0.0

        # Step 6: combine.
        means = theta_fc + residual_fc

        # Step 7: 80% intervals from theta + residual std in quadrature.
        intervals = _theta_intervals(result, horizon)
        if intervals is not None:
            theta_lo, theta_hi = intervals
            theta_spread = 0.5 * (theta_hi - theta_lo)
            # Add residual std in quadrature: extra spread = z * std.
            extra = _Z80 * max(residual_std, 0.0)
            # Combine z*sigma_theta and z*sigma_resid in quadrature.
            sigma_theta = np.maximum(theta_spread / _Z80, 0.0)
            sigma_total = np.sqrt(sigma_theta ** 2 + max(residual_std, 0.0) ** 2)
            spread = _Z80 * np.maximum(sigma_total, _RESID_FLOOR)
        else:
            # Fall back to empirical std combined with residual std.
            emp_std = _empirical_mom_std(panel)
            sigma_total = np.sqrt(emp_std ** 2 + max(residual_std, 0.0) ** 2)
            spread = _Z80 * np.full(horizon, max(sigma_total, _RESID_FLOOR), dtype=float)

        # Sanity-clip the means.
        means = np.clip(means, _MOM_LO_CLIP, _MOM_HI_CLIP)
        los = means - spread
        his = means + spread

        # Defensive: replace any NaN/inf with naive numbers.
        if not (np.all(np.isfinite(means)) and np.all(np.isfinite(los)) and np.all(np.isfinite(his))):
            return self._naive(panel, horizon)

        return means.astype(float), los.astype(float), his.astype(float)

    # ---------- naive fallback ----------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
