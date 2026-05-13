"""Pluggable forecast strategies for the horse race.

Every strategy implements `fit_and_predict(panel, horizon)` and gets
auto-discovered by race.py. Drop a new file in this package and it
joins the next race — no other wiring required.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

import numpy as np
import pandas as pd


class ForecastStrategy(ABC):
    """Contract every contestant implements.

    The race calls fit_and_predict at each rolling-backtest cut: train
    on `panel` (data up to & including the cut date) and produce a
    `horizon`-step forecast in CPI MoM log-% space.

    Implementations MUST NOT raise during normal operation — wrap risky
    code in try/except and fall back to a naive forecast (e.g. the last
    observed MoM repeated). Strategies that crash on a cut still count
    against the strategy's score.
    """

    name: str

    @abstractmethod
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return (mean, lo80, hi80), each shape (horizon,) — MoM % per future month."""
