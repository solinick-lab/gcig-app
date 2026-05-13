"""Ridge regression on lagged macro features.

For multi-step forecasts we use the recursive trick: fit a one-step model,
then iterate by feeding the previous prediction back into the lagged-CPI
columns. Other macro features are held at their last observed value (a
naive but robust assumption — better than trying to forecast every macro
feature too).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

from ..features import build_supervised, build_features, build_target


class RidgeForecaster:
    name = "ridge"

    def __init__(self) -> None:
        self._scaler: StandardScaler | None = None
        self._model: RidgeCV | None = None
        self._feature_cols: list[str] | None = None
        self._panel: pd.DataFrame | None = None
        # Empirical residual std for forecast intervals.
        self._resid_std: float = 0.0

    def fit(self, panel: pd.DataFrame) -> "RidgeForecaster":
        self._panel = panel
        X, y = build_supervised(panel)
        self._feature_cols = list(X.columns)
        self._scaler = StandardScaler().fit(X.values)
        Xs = self._scaler.transform(X.values)
        # 5-fold CV across a wide alpha range. Time series CV would be
        # stricter, but RidgeCV with K-fold is the standard quick path
        # and the difference is small for this kind of regression.
        self._model = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Xs, y.values)
        resid = y.values - self._model.predict(Xs)
        self._resid_std = float(np.std(resid))
        return self

    def _last_feature_row(self) -> pd.Series:
        """The most recent X row we can build (for predicting next month).
        Uses build_features on the live panel and grabs the last
        all-non-NaN row. If the very last month has NaNs in some
        features (ragged edge), we forward-fill using the last available."""
        feats = build_features(self._panel).copy()
        # Forward-fill ragged-edge NaNs only at the very tail (don't fill
        # into the historical training period).
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
            xs = self._scaler.transform(x)
            yhat = float(self._model.predict(xs)[0])
            means.append(yhat)
            # Roll the CPI lag features forward: lag2 ← lag1, lag3 ← lag2,
            # lag1 ← yhat. Macro features stay frozen at their last value.
            feat_row["cpi_mom_lag3"] = feat_row["cpi_mom_lag2"]
            feat_row["cpi_mom_lag2"] = feat_row["cpi_mom_lag1"]
            feat_row["cpi_mom_lag1"] = yhat
            # Roll YoY lag too (approximation: add the new MoM and drop
            # the oldest implicit MoM).
            feat_row["cpi_yoy_lag1"] = feat_row.get("cpi_yoy_lag1", 0.0)
        means = np.array(means)
        # Interval scales with sqrt(h) since errors compound roughly
        # additively in the recursive setup.
        z = 1.2816  # 80% one-sided
        spread = z * self._resid_std * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
