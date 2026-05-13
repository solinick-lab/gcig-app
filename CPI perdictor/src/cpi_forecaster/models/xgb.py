"""XGBoost on the same feature matrix as Ridge.

Same recursive-forecast structure: train one-step, iterate by rolling
CPI lags forward and holding macro features at their last value.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import xgboost as xgb

from ..features import build_supervised, build_features


class XgbForecaster:
    name = "xgb"

    def __init__(self) -> None:
        self._model: xgb.XGBRegressor | None = None
        self._feature_cols: list[str] | None = None
        self._panel: pd.DataFrame | None = None
        self._resid_std: float = 0.0

    def fit(self, panel: pd.DataFrame) -> "XgbForecaster":
        self._panel = panel
        X, y = build_supervised(panel)
        self._feature_cols = list(X.columns)
        # Conservative settings — small dataset (~200 monthly rows).
        # Heavier trees overfit immediately.
        self._model = xgb.XGBRegressor(
            n_estimators=400,
            max_depth=3,
            learning_rate=0.03,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=1.0,
            random_state=42,
            n_jobs=2,
            verbosity=0,
        )
        self._model.fit(X.values, y.values)
        resid = y.values - self._model.predict(X.values)
        self._resid_std = float(np.std(resid))
        return self

    def feature_importance(self) -> dict[str, float]:
        if self._model is None or self._feature_cols is None:
            return {}
        imp = self._model.feature_importances_
        return {c: float(v) for c, v in zip(self._feature_cols, imp)}

    def _last_feature_row(self) -> pd.Series:
        feats = build_features(self._panel).copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row after forward-fill.")
        return feats.iloc[-1]

    def predict(self, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        if self._model is None or self._feature_cols is None:
            raise RuntimeError("Call fit() first.")
        feat_row = self._last_feature_row().copy()
        means = []
        for _ in range(horizon):
            x = feat_row[self._feature_cols].values.reshape(1, -1)
            yhat = float(self._model.predict(x)[0])
            means.append(yhat)
            feat_row["cpi_mom_lag3"] = feat_row["cpi_mom_lag2"]
            feat_row["cpi_mom_lag2"] = feat_row["cpi_mom_lag1"]
            feat_row["cpi_mom_lag1"] = yhat
        means = np.array(means)
        z = 1.2816
        spread = z * self._resid_std * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
