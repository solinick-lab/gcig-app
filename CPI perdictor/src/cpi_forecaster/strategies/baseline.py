"""Baseline strategy — what's currently in production.

Equal-weighted mean of SARIMA + Ridge + XGBoost. The live system uses
inverse-error weights computed from a backtest, but that's a chicken-
and-egg-style construct that's hard to compare fairly here. Equal-
weight is the cleanest "no special sauce" baseline; competing strategies
have to beat THIS to claim a real win.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..models import RidgeForecaster, SarimaForecaster, XgbForecaster


class BaselineEnsembleStrategy(ForecastStrategy):
    name = "baseline"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        means: list[np.ndarray] = []
        los: list[np.ndarray] = []
        his: list[np.ndarray] = []
        for cls in (SarimaForecaster, RidgeForecaster, XgbForecaster):
            try:
                m, l, h = cls().fit(panel).predict(horizon)
            except Exception:
                # Defensive fallback to the last observed MoM.
                from ..features import build_target

                last = float(build_target(panel).dropna().iloc[-1])
                m = np.array([last] * horizon)
                l = m - 0.30
                h = m + 0.30
            means.append(m)
            los.append(l)
            his.append(h)
        return (
            np.mean(means, axis=0),
            np.mean(los, axis=0),
            np.mean(his, axis=0),
        )
