"""Univariate SARIMA on CPI log-MoM. Strong baseline for inflation.

Order grid is small and pre-vetted — a full auto-arima would be slower
without changing the answer much for this series. We pick the lowest-AIC
combo over the grid.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from ..fred import TARGET

# Small grid: SARIMA(p,d,q)(P,D,Q,12). CPI log-MoM is already stationary
# so d=0 always; seasonal differencing handled by D=1 when present.
ORDER_GRID = [
    ((0, 0, 0), (0, 1, 1, 12)),
    ((1, 0, 0), (0, 1, 1, 12)),
    ((0, 0, 1), (0, 1, 1, 12)),
    ((1, 0, 1), (0, 1, 1, 12)),
    ((2, 0, 1), (0, 1, 1, 12)),
    ((1, 0, 0), (1, 0, 1, 12)),
    ((1, 0, 1), (1, 0, 0, 12)),
]


class SarimaForecaster:
    name = "sarima"

    def __init__(self) -> None:
        self._fit = None
        self._order: tuple | None = None
        self._seasonal: tuple | None = None

    def fit(self, panel: pd.DataFrame) -> "SarimaForecaster":
        cpi = panel[TARGET.fred_id].dropna()
        y = (np.log(cpi) - np.log(cpi.shift(1))).dropna() * 100.0  # log-MoM %

        best = None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            for order, seasonal in ORDER_GRID:
                try:
                    res = SARIMAX(
                        y,
                        order=order,
                        seasonal_order=seasonal,
                        enforce_stationarity=False,
                        enforce_invertibility=False,
                    ).fit(disp=False)
                except Exception:
                    continue
                if best is None or res.aic < best[0]:
                    best = (res.aic, res, order, seasonal)
        if best is None:
            raise RuntimeError("All SARIMA orders failed to fit")
        _, self._fit, self._order, self._seasonal = best
        return self

    def predict(self, horizon: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return (mean, lo80, hi80) of MoM % change for the next `horizon` months."""
        if self._fit is None:
            raise RuntimeError("Call fit() first.")
        forecast = self._fit.get_forecast(steps=horizon)
        mean = forecast.predicted_mean.values
        ci = forecast.conf_int(alpha=0.20)  # 80% interval
        return mean, ci.iloc[:, 0].values, ci.iloc[:, 1].values
