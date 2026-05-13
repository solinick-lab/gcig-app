"""Agent P: Local-level state-space (Kalman) model with macro covariates.

A textbook structural-time-series approach. We let the level of CPI MoM
walk randomly (capturing slow regime drift) while a small set of
exogenous macro regressors absorb short-term shocks.

Model:
    y_t = mu_t + beta' x_{t-1} + eps_t,    eps_t ~ N(0, sigma_eps^2)
    mu_t = mu_{t-1} + eta_t,               eta_t ~ N(0, sigma_eta^2)

Implemented via `statsmodels.tsa.statespace.UnobservedComponents`
with `level='local level'` and `irregular=True`.

Exogenous regressors (curated, all lag-1):
  - DCOILWTICO MoM%
  - PPIACO MoM%
  - CES0500000003 (wages) MoM%
  - DTWEXBGS MoM%
  - MICH (level — already roughly stationary)

For multi-step forecasting we hold the exog at the last observed values
(we don't model exog dynamics here). The Kalman filter naturally
handles structural drift via the random-walk level term.

Defensive: UC can fail to converge (singular Hessian, non-PSD cov, etc).
We catch *any* exception and fall back to last-observed MoM repeat.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET
from ..features import build_target


# Suppress noisy convergence warnings from statsmodels — we handle
# convergence failures via the try/except.
warnings.filterwarnings("ignore")


_Z80 = 1.2816               # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10

# The exog series we use. MICH is a level (stationary-ish); the rest are
# transformed to MoM % change.
_EXOG_MOM = ("DCOILWTICO", "PPIACO", "CES0500000003", "DTWEXBGS")
_EXOG_LEVEL = ("MICH",)


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _build_exog(panel: pd.DataFrame) -> pd.DataFrame:
    """Curated exog matrix, all lag-1. NaN rows preserved here; caller aligns."""
    rows: dict[str, pd.Series] = {}
    for sid in _EXOG_MOM:
        if sid in panel.columns:
            rows[f"{sid}_mom_lag1"] = _mom(panel[sid]).shift(1)
    for sid in _EXOG_LEVEL:
        if sid in panel.columns:
            rows[f"{sid}_lvl_lag1"] = panel[sid].shift(1)
    if not rows:
        return pd.DataFrame(index=panel.index)
    df = pd.concat(rows, axis=1)
    df = df.replace([np.inf, -np.inf], np.nan)
    return df


def _last_observed_mom(panel: pd.DataFrame) -> float:
    try:
        s = build_target(panel).dropna()
        if s.empty:
            return 0.0
        return float(s.iloc[-1])
    except Exception:
        return 0.0


def _empirical_mom_std(panel: pd.DataFrame) -> float:
    try:
        s = build_target(panel).dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())
    except Exception:
        return 0.25


class KalmanStrategy(ForecastStrategy):
    """Local-level state-space model with macro exogenous regressors."""

    name = "agent_p_kalman"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # --------------- main path: UnobservedComponents ----------------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from statsmodels.tsa.statespace.structural import UnobservedComponents

        y_full = build_target(panel)
        X_full = _build_exog(panel)

        # Align y and X: same index, drop any rows with NaN in either.
        df = pd.concat([y_full.rename("y"), X_full], axis=1).dropna()
        if len(df) < 36 or X_full.shape[1] == 0:
            return self._naive(panel, horizon)

        y_arr = df["y"].values.astype(float)
        exog_cols = [c for c in df.columns if c != "y"]
        X_arr = df[exog_cols].values.astype(float)

        # Last observed exog row — held flat across the horizon since we
        # don't model exog dynamics.
        last_exog = X_arr[-1:, :].copy()
        future_exog = np.repeat(last_exog, horizon, axis=0)

        try:
            model = UnobservedComponents(
                y_arr,
                exog=X_arr,
                level="local level",
                irregular=True,
            )
            # disp=0 suppresses the optimizer chatter; method='lbfgs' is
            # the statsmodels default and is fast enough for n~700.
            results = model.fit(disp=0, maxiter=200)
        except Exception:
            return self._naive(panel, horizon)

        try:
            forecast_obj = results.get_forecast(steps=horizon, exog=future_exog)
            mean = np.asarray(forecast_obj.predicted_mean, dtype=float)
            ci = forecast_obj.conf_int(alpha=0.20)  # 80% interval
            ci_arr = np.asarray(ci, dtype=float)
            lo = ci_arr[:, 0]
            hi = ci_arr[:, 1]
        except Exception:
            return self._naive(panel, horizon)

        # Sanity checks: replace any non-finite output with naive fallback.
        if not (np.all(np.isfinite(mean)) and np.all(np.isfinite(lo)) and np.all(np.isfinite(hi))):
            return self._naive(panel, horizon)

        # Clip means and ensure intervals don't collapse below the floor.
        mean = np.clip(mean, _MOM_LO_CLIP, _MOM_HI_CLIP)
        # Enforce a minimum half-width so intervals stay realistic even
        # when UC reports an over-confident posterior.
        half = (hi - lo) / 2.0
        floor = _Z80 * _RESID_FLOOR
        too_tight = half < floor
        if np.any(too_tight):
            half = np.where(too_tight, floor, half)
            lo = mean - half
            hi = mean + half

        return mean, lo, hi

    # --------------- fallback: persistence ----------------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
