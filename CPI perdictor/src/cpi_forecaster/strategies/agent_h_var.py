"""Agent H: Vector Autoregression (VAR) strategy.

Unlike the existing models which treat CPI as the target and macro features
as exogenous one-way inputs, VAR models the *joint* dynamics of multiple
time series simultaneously. CPI, oil, PPI, shelter, wages, USD, and
inflation expectations all forecast each other, capturing the cross-series
feedback that univariate / direct-multistep models miss (e.g. oil shock ->
PPI -> CPI passthrough).

Design choices:
  * Curated subset of 6 series (NOT all 15). VAR's parameter count is
    O(k^2 * p), so adding variables blows up degrees of freedom fast on
    monthly macro data where we typically have ~250-700 rows.
  * Stationarity transforms: CPI/PPI/oil/shelter/USD as MoM log-%, wages
    as YoY %, MICH as level (it's already roughly stationary, mean-revert
    around long-run inflation expectations).
  * Lag selection by BIC over p in {1, 2, 3, 4}.
  * Forecast: pull the CPIAUCSL MoM column out of `forecast_interval`.
  * Defensive: nested try/except, fall back to last-MoM repeat per the
    race contract.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MAX_LAGS = 4                 # cap VAR lag order to control parameter count
_MIN_OBS = 60                 # need a reasonable training window for VAR


# ----------------------------- helpers ---------------------------------

def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _last_observed_mom(panel: pd.DataFrame) -> float:
    try:
        cpi = panel[TARGET.fred_id]
        return float(_log_mom(cpi).dropna().iloc[-1])
    except Exception:
        return 0.0


def _empirical_mom_std(panel: pd.DataFrame) -> float:
    try:
        cpi = panel[TARGET.fred_id]
        s = _log_mom(cpi).dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())
    except Exception:
        return 0.25


def _build_var_panel(panel: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    """Build the stationary multivariate panel for VAR.

    Curated 6-variable subset chosen for economic relevance + minimum
    overlap of information. Returns (df, target_col_name). target_col_name
    is the name of the CPI column in the returned DataFrame.
    """
    cols: dict[str, pd.Series] = {}

    # CPI: MoM log-% (this is the column we extract from the forecast).
    cpi = panel[TARGET.fred_id]
    cols["cpi_mom"] = _log_mom(cpi)

    # PPI All Commodities: MoM % — upstream cost pressure.
    if "PPIACO" in panel.columns:
        cols["ppi_mom"] = _mom(panel["PPIACO"])

    # WTI Oil: MoM % — primary commodity shock channel.
    if "DCOILWTICO" in panel.columns:
        cols["oil_mom"] = _mom(panel["DCOILWTICO"])

    # Shelter CPI: MoM % — sticky, dominant CPI weight (~33%).
    if "CUSR0000SAH1" in panel.columns:
        cols["shelter_mom"] = _mom(panel["CUSR0000SAH1"])
    elif "CSUSHPISA" in panel.columns:
        cols["shelter_mom"] = _mom(panel["CSUSHPISA"])

    # Wages: YoY % — wage-price spiral channel. Already smooth.
    if "CES0500000003" in panel.columns:
        cols["wage_yoy"] = _yoy(panel["CES0500000003"])

    # USD broad: MoM % — import-price passthrough.
    if "DTWEXBGS" in panel.columns:
        cols["usd_mom"] = _mom(panel["DTWEXBGS"])

    # Inflation expectations level (Michigan 1Y).
    if "MICH" in panel.columns:
        cols["mich"] = panel["MICH"].astype(float)

    df = pd.concat(cols, axis=1)
    df = df.replace([np.inf, -np.inf], np.nan)
    # VAR cannot tolerate NaN; drop incomplete rows then ffill stragglers.
    df = df.ffill(limit=2).dropna(how="any")
    return df, "cpi_mom"


# --------------------------- the strategy -----------------------------


class VARStrategy(ForecastStrategy):
    """Vector Autoregression on a curated 6-variable macro panel."""

    name = "agent_h_var"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---------- main path: VAR with BIC lag selection ----------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from statsmodels.tsa.api import VAR

        df, target_col = _build_var_panel(panel)
        if df.empty or len(df) < _MIN_OBS or target_col not in df.columns:
            return self._naive(panel, horizon)

        # Trim to the most recent stretch for stability — older data
        # (pre-2000) has structural breaks (Volcker era, etc.) that hurt
        # VAR estimates more than they help.
        if len(df) > 360:
            df = df.iloc[-360:]

        Y = df.values.astype(float)
        col_names = list(df.columns)
        target_ix = col_names.index(target_col)

        try:
            model = VAR(Y)
            # `ic='bic'` picks the lag that minimises BIC up to maxlags.
            results = model.fit(maxlags=_MAX_LAGS, ic="bic")
        except Exception:
            # If BIC selection fails (e.g. singular cov), fall back to p=1.
            try:
                results = VAR(Y).fit(1)
            except Exception:
                return self._naive(panel, horizon)

        p = max(int(getattr(results, "k_ar", 1) or 1), 1)
        if Y.shape[0] < p + 1:
            return self._naive(panel, horizon)

        last_obs = Y[-p:]

        # ---- point forecast + analytic 80% interval ----
        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        used_interval = False
        try:
            point, lower, upper = results.forecast_interval(
                y=last_obs, steps=horizon, alpha=0.20
            )
            point = np.asarray(point)
            lower = np.asarray(lower)
            upper = np.asarray(upper)
            if (
                point.ndim == 2
                and point.shape == (horizon, len(col_names))
                and lower.shape == point.shape
                and upper.shape == point.shape
            ):
                means_raw = point[:, target_ix]
                los_raw = lower[:, target_ix]
                his_raw = upper[:, target_ix]
                if np.all(np.isfinite(means_raw)):
                    means = means_raw
                    los = los_raw
                    his = his_raw
                    used_interval = True
        except Exception:
            used_interval = False

        if not used_interval:
            # Fall back: point forecast from `forecast`, intervals from
            # residual std on the CPI equation, scaled by sqrt(h).
            try:
                point = np.asarray(results.forecast(y=last_obs, steps=horizon))
                if point.shape != (horizon, len(col_names)) or not np.all(
                    np.isfinite(point)
                ):
                    return self._naive(panel, horizon)
                means = point[:, target_ix]
            except Exception:
                return self._naive(panel, horizon)

            # Residual std of CPI equation.
            try:
                resid = np.asarray(results.resid)
                if resid.ndim == 2 and resid.shape[1] == len(col_names):
                    resid_std = float(np.std(resid[:, target_ix]))
                else:
                    resid_std = _empirical_mom_std(panel)
            except Exception:
                resid_std = _empirical_mom_std(panel)

            resid_std = max(resid_std, _RESID_FLOOR)
            steps = np.arange(1, horizon + 1, dtype=float)
            spreads = _Z80 * resid_std * np.sqrt(steps)
            los = means - spreads
            his = means + spreads

        # ---- sanity-clip and floor interval widths ----
        means_out = np.clip(means.astype(float), _MOM_LO_CLIP, _MOM_HI_CLIP)
        # Ensure non-collapsing intervals.
        spreads = np.maximum(
            np.abs(his - means).astype(float),
            np.abs(means - los).astype(float),
        )
        spreads = np.maximum(spreads, _Z80 * _RESID_FLOOR)
        los_out = means_out - spreads
        his_out = means_out + spreads

        if not (np.all(np.isfinite(means_out)) and np.all(np.isfinite(los_out)) and np.all(np.isfinite(his_out))):
            return self._naive(panel, horizon)

        return means_out, los_out, his_out

    # ---------- last-resort fallback: persistence ----------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1, dtype=float))
        return means, means - spread, means + spread
