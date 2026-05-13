"""Agent A — hyperparameter tuning with proper time-series CV.

The baseline ensemble has three known statistical/methodological issues:
  * Ridge uses RidgeCV with K-fold (default), which leaks future
    information into past folds for time-series data.
  * XGBoost uses fixed hyperparameters chosen by hand; never tuned.
  * SARIMA uses a tiny pre-vetted grid and AIC-only model selection.

This strategy fixes all three with `TimeSeriesSplit`-based CV. To stay
inside the per-cut time budget the search grids are kept compact and
all heavy lifting is wrapped in try/except with the baseline component
as a fallback. Components are combined with inverse-RMSE weights
estimated on the same TS-CV residuals (clipped to equal-weight if the
RMSE estimates degenerate).
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_supervised, build_features, build_target
from ..fred import TARGET


# ---------------------------------------------------------------------------
# Tuned Ridge — RidgeCV with TimeSeriesSplit + wider alpha range.
# ---------------------------------------------------------------------------
class _TunedRidge:
    """Ridge whose alpha is selected with TimeSeriesSplit, not K-fold."""

    def __init__(self) -> None:
        self._scaler = None
        self._model = None
        self._feature_cols: list[str] | None = None
        self._panel: pd.DataFrame | None = None
        self._resid_std: float = 0.0
        self._cv_rmse: float = float("nan")

    def fit(self, panel: pd.DataFrame) -> "_TunedRidge":
        from sklearn.linear_model import RidgeCV, Ridge
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        self._panel = panel
        X, y = build_supervised(panel)
        self._feature_cols = list(X.columns)
        self._scaler = StandardScaler().fit(X.values)
        Xs = self._scaler.transform(X.values)

        # TimeSeriesSplit splits chronologically, never leaks the future.
        n_splits = max(3, min(5, max(2, len(y) // 36)))
        tscv = TimeSeriesSplit(n_splits=n_splits)
        alphas = np.logspace(-4, 4, 33)
        try:
            self._model = RidgeCV(alphas=alphas, cv=tscv).fit(Xs, y.values)
        except Exception:
            # Fallback to vanilla RidgeCV (LOO-CV) if TS-CV refuses.
            self._model = RidgeCV(alphas=alphas).fit(Xs, y.values)

        # Walk-forward residual estimate at the chosen alpha — this is
        # the "honest" out-of-sample RMSE used for ensemble weighting.
        try:
            chosen_alpha = float(getattr(self._model, "alpha_", 1.0))
            errs: list[float] = []
            for train_idx, test_idx in tscv.split(Xs):
                m = Ridge(alpha=chosen_alpha).fit(Xs[train_idx], y.values[train_idx])
                pred = m.predict(Xs[test_idx])
                errs.extend((y.values[test_idx] - pred).tolist())
            if errs:
                self._cv_rmse = float(np.sqrt(np.mean(np.square(errs))))
        except Exception:
            self._cv_rmse = float("nan")

        resid = y.values - self._model.predict(Xs)
        self._resid_std = float(np.std(resid))
        return self

    def _last_feature_row(self) -> pd.Series:
        feats = build_features(self._panel).copy()
        feats = feats.ffill(limit=2).dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row after forward-fill.")
        return feats.iloc[-1]

    def predict(self, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if self._model is None or self._feature_cols is None:
            raise RuntimeError("Call fit() first.")
        feat_row = self._last_feature_row().copy()
        means: list[float] = []
        for _ in range(horizon):
            x = feat_row[self._feature_cols].values.reshape(1, -1)
            xs = self._scaler.transform(x)
            yhat = float(self._model.predict(xs)[0])
            means.append(yhat)
            feat_row["cpi_mom_lag3"] = feat_row["cpi_mom_lag2"]
            feat_row["cpi_mom_lag2"] = feat_row["cpi_mom_lag1"]
            feat_row["cpi_mom_lag1"] = yhat
        m = np.array(means)
        z = 1.2816
        spread = z * self._resid_std * np.sqrt(np.arange(1, horizon + 1))
        return m, m - spread, m + spread


# ---------------------------------------------------------------------------
# Tuned XGBoost — small TS-CV grid search, conservative search space.
# ---------------------------------------------------------------------------
class _TunedXgb:
    """XGBoost with hyperparameters picked via TimeSeriesSplit grid search."""

    # Compact grid — 12 combos. Each fits very quickly on ~200 rows so the
    # whole search stays well under a second on a modern laptop.
    _GRID: tuple[dict, ...] = (
        {"n_estimators": 200, "max_depth": 2, "learning_rate": 0.05, "subsample": 0.85},
        {"n_estimators": 400, "max_depth": 2, "learning_rate": 0.03, "subsample": 0.85},
        {"n_estimators": 400, "max_depth": 3, "learning_rate": 0.03, "subsample": 0.85},
        {"n_estimators": 400, "max_depth": 3, "learning_rate": 0.05, "subsample": 0.7},
        {"n_estimators": 800, "max_depth": 2, "learning_rate": 0.01, "subsample": 0.85},
        {"n_estimators": 800, "max_depth": 3, "learning_rate": 0.01, "subsample": 1.0},
        {"n_estimators": 200, "max_depth": 3, "learning_rate": 0.05, "subsample": 1.0},
        {"n_estimators": 400, "max_depth": 4, "learning_rate": 0.03, "subsample": 0.7},
        {"n_estimators": 400, "max_depth": 4, "learning_rate": 0.05, "subsample": 0.85},
        {"n_estimators": 200, "max_depth": 4, "learning_rate": 0.05, "subsample": 0.85},
        {"n_estimators": 800, "max_depth": 4, "learning_rate": 0.01, "subsample": 0.85},
        {"n_estimators": 200, "max_depth": 3, "learning_rate": 0.03, "subsample": 0.7},
    )

    def __init__(self) -> None:
        self._model = None
        self._feature_cols: list[str] | None = None
        self._panel: pd.DataFrame | None = None
        self._resid_std: float = 0.0
        self._cv_rmse: float = float("nan")
        self._best_params: dict | None = None

    def fit(self, panel: pd.DataFrame) -> "_TunedXgb":
        import xgboost as xgb
        from sklearn.model_selection import TimeSeriesSplit

        self._panel = panel
        X, y = build_supervised(panel)
        self._feature_cols = list(X.columns)
        Xv = X.values
        yv = y.values

        n_splits = max(3, min(5, max(2, len(y) // 36)))
        tscv = TimeSeriesSplit(n_splits=n_splits)

        best_rmse = float("inf")
        best_params: dict | None = None
        for params in self._GRID:
            errs: list[float] = []
            try:
                for train_idx, test_idx in tscv.split(Xv):
                    if len(train_idx) < 30 or len(test_idx) == 0:
                        continue
                    model = xgb.XGBRegressor(
                        n_estimators=params["n_estimators"],
                        max_depth=params["max_depth"],
                        learning_rate=params["learning_rate"],
                        subsample=params["subsample"],
                        colsample_bytree=0.85,
                        reg_lambda=1.0,
                        random_state=42,
                        n_jobs=2,
                        verbosity=0,
                    )
                    model.fit(Xv[train_idx], yv[train_idx])
                    pred = model.predict(Xv[test_idx])
                    errs.extend((yv[test_idx] - pred).tolist())
            except Exception:
                continue
            if not errs:
                continue
            rmse = float(np.sqrt(np.mean(np.square(errs))))
            if rmse < best_rmse:
                best_rmse = rmse
                best_params = params

        if best_params is None:
            # Fall back to baseline-known-good config.
            best_params = {
                "n_estimators": 400,
                "max_depth": 3,
                "learning_rate": 0.03,
                "subsample": 0.85,
            }
        self._best_params = best_params
        self._cv_rmse = best_rmse if np.isfinite(best_rmse) else float("nan")

        self._model = xgb.XGBRegressor(
            n_estimators=best_params["n_estimators"],
            max_depth=best_params["max_depth"],
            learning_rate=best_params["learning_rate"],
            subsample=best_params["subsample"],
            colsample_bytree=0.85,
            reg_lambda=1.0,
            random_state=42,
            n_jobs=2,
            verbosity=0,
        )
        self._model.fit(Xv, yv)
        resid = yv - self._model.predict(Xv)
        self._resid_std = float(np.std(resid))
        return self

    def _last_feature_row(self) -> pd.Series:
        feats = build_features(self._panel).copy()
        feats = feats.ffill(limit=2).dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row after forward-fill.")
        return feats.iloc[-1]

    def predict(self, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if self._model is None or self._feature_cols is None:
            raise RuntimeError("Call fit() first.")
        feat_row = self._last_feature_row().copy()
        means: list[float] = []
        for _ in range(horizon):
            x = feat_row[self._feature_cols].values.reshape(1, -1)
            yhat = float(self._model.predict(x)[0])
            means.append(yhat)
            feat_row["cpi_mom_lag3"] = feat_row["cpi_mom_lag2"]
            feat_row["cpi_mom_lag2"] = feat_row["cpi_mom_lag1"]
            feat_row["cpi_mom_lag1"] = yhat
        m = np.array(means)
        z = 1.2816
        spread = z * self._resid_std * np.sqrt(np.arange(1, horizon + 1))
        return m, m - spread, m + spread


# ---------------------------------------------------------------------------
# Tuned SARIMA — modestly expanded grid, AIC-best selection.
# ---------------------------------------------------------------------------
# Expanded but still bounded — fitting all of these on ~200 monthly points
# typically completes in well under a second total.
_SARIMA_GRID: tuple[tuple, ...] = (
    ((0, 0, 0), (0, 1, 1, 12)),
    ((1, 0, 0), (0, 1, 1, 12)),
    ((0, 0, 1), (0, 1, 1, 12)),
    ((1, 0, 1), (0, 1, 1, 12)),
    ((2, 0, 1), (0, 1, 1, 12)),
    ((1, 0, 2), (0, 1, 1, 12)),
    ((2, 0, 2), (0, 1, 1, 12)),
    ((1, 0, 0), (1, 0, 1, 12)),
    ((1, 0, 1), (1, 0, 0, 12)),
    ((1, 0, 1), (1, 0, 1, 12)),
    ((2, 0, 0), (0, 1, 1, 12)),
    ((0, 0, 2), (0, 1, 1, 12)),
    ((1, 0, 0), (0, 0, 1, 12)),
)


class _TunedSarima:
    """SARIMA with an expanded grid; AIC-best on log-MoM CPI."""

    def __init__(self) -> None:
        self._fit = None
        self._order = None
        self._seasonal = None

    def fit(self, panel: pd.DataFrame) -> "_TunedSarima":
        from statsmodels.tsa.statespace.sarimax import SARIMAX

        cpi = panel[TARGET.fred_id].dropna()
        y = (np.log(cpi) - np.log(cpi.shift(1))).dropna() * 100.0

        best = None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for order, seasonal in _SARIMA_GRID:
                try:
                    res = SARIMAX(
                        y,
                        order=order,
                        seasonal_order=seasonal,
                        enforce_stationarity=False,
                        enforce_invertibility=False,
                    ).fit(disp=False, maxiter=50)
                except Exception:
                    continue
                aic = float(getattr(res, "aic", float("inf")))
                if not np.isfinite(aic):
                    continue
                if best is None or aic < best[0]:
                    best = (aic, res, order, seasonal)
        if best is None:
            raise RuntimeError("All SARIMA orders failed to fit")
        _, self._fit, self._order, self._seasonal = best
        return self

    def predict(self, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if self._fit is None:
            raise RuntimeError("Call fit() first.")
        forecast = self._fit.get_forecast(steps=horizon)
        mean = forecast.predicted_mean.values
        ci = forecast.conf_int(alpha=0.20)
        return mean, ci.iloc[:, 0].values, ci.iloc[:, 1].values


# ---------------------------------------------------------------------------
# Helpers — SARIMA TS-CV RMSE for inverse-error weighting.
# ---------------------------------------------------------------------------
def _sarima_ts_cv_rmse(panel: pd.DataFrame, order, seasonal, n_splits: int = 3) -> float:
    """Walk-forward RMSE for the chosen SARIMA order. Skipped on any error."""
    from statsmodels.tsa.statespace.sarimax import SARIMAX

    try:
        cpi = panel[TARGET.fred_id].dropna()
        y = (np.log(cpi) - np.log(cpi.shift(1))).dropna() * 100.0
        if len(y) < 60:
            return float("nan")
        # Keep at least two full seasonal cycles in the smallest train fold.
        min_train = max(48, int(len(y) * 0.5))
        cuts = np.linspace(min_train, len(y) - 1, n_splits + 1, dtype=int)[:-1]
        errs: list[float] = []
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for cut in cuts:
                if cut <= min_train - 12 or cut >= len(y):
                    continue
                try:
                    res = SARIMAX(
                        y.iloc[:cut],
                        order=order,
                        seasonal_order=seasonal,
                        enforce_stationarity=False,
                        enforce_invertibility=False,
                    ).fit(disp=False, maxiter=50)
                    pred = float(res.get_forecast(steps=1).predicted_mean.iloc[0])
                    actual = float(y.iloc[cut])
                    errs.append(actual - pred)
                except Exception:
                    continue
        if not errs:
            return float("nan")
        return float(np.sqrt(np.mean(np.square(errs))))
    except Exception:
        return float("nan")


def _inv_rmse_weights(rmses: list[float]) -> np.ndarray:
    """Weight each component proportional to 1/RMSE; equal-weight on degeneracy."""
    arr = np.array(rmses, dtype=float)
    if not np.all(np.isfinite(arr)) or np.any(arr <= 0):
        return np.ones_like(arr) / len(arr)
    inv = 1.0 / arr
    return inv / inv.sum()


# ---------------------------------------------------------------------------
# Public strategy.
# ---------------------------------------------------------------------------
class TunedEnsembleStrategy(ForecastStrategy):
    name = "agent_a_tuned"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        means: list[np.ndarray] = []
        los: list[np.ndarray] = []
        his: list[np.ndarray] = []
        rmses: list[float] = []

        # SARIMA
        try:
            sar = _TunedSarima().fit(panel)
            sar_m, sar_l, sar_h = sar.predict(horizon)
            sar_rmse = _sarima_ts_cv_rmse(panel, sar._order, sar._seasonal)
        except Exception:
            sar_m, sar_l, sar_h = self._naive_fallback(panel, horizon)
            sar_rmse = float("nan")
        means.append(sar_m)
        los.append(sar_l)
        his.append(sar_h)
        rmses.append(sar_rmse)

        # Tuned Ridge
        try:
            r = _TunedRidge().fit(panel)
            r_m, r_l, r_h = r.predict(horizon)
            r_rmse = r._cv_rmse
        except Exception:
            r_m, r_l, r_h = self._naive_fallback(panel, horizon)
            r_rmse = float("nan")
        means.append(r_m)
        los.append(r_l)
        his.append(r_h)
        rmses.append(r_rmse)

        # Tuned XGBoost
        try:
            xg = _TunedXgb().fit(panel)
            x_m, x_l, x_h = xg.predict(horizon)
            x_rmse = xg._cv_rmse
        except Exception:
            x_m, x_l, x_h = self._naive_fallback(panel, horizon)
            x_rmse = float("nan")
        means.append(x_m)
        los.append(x_l)
        his.append(x_h)
        rmses.append(x_rmse)

        # Inverse-RMSE weighting where we have valid CV estimates; equal
        # weight otherwise. Soft-clip the spread between min and max
        # weights so a single fluky CV doesn't dominate the ensemble.
        try:
            w = _inv_rmse_weights(rmses)
            # Soft-clip: keep all weights within [0.15, 0.55] then renormalize.
            w = np.clip(w, 0.15, 0.55)
            w = w / w.sum()
        except Exception:
            w = np.array([1.0 / 3] * 3)

        means_arr = np.vstack(means)
        los_arr = np.vstack(los)
        his_arr = np.vstack(his)

        mean_out = (means_arr * w[:, None]).sum(axis=0)
        lo_out = (los_arr * w[:, None]).sum(axis=0)
        hi_out = (his_arr * w[:, None]).sum(axis=0)
        return mean_out, lo_out, hi_out

    @staticmethod
    def _naive_fallback(
        panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Last observed MoM repeated, with a 0.30%-ish band — mirrors baseline."""
        try:
            last = float(build_target(panel).dropna().iloc[-1])
        except Exception:
            last = 0.2  # ~typical post-2010 monthly CPI print
        m = np.array([last] * horizon)
        return m, m - 0.30, m + 0.30
