"""Agent WW — Term-structure VAR.

A 5-variable Vector Autoregression on the *term structure of inflation
expectations + policy rate*, jointly evolved with CPI MoM:

    (CPI MoM, T5YIE diff, T10YIE diff, T5YIFR diff, FEDFUNDS diff)

Why this should work where agent_h_var (ranked 0.327) didn't:
  * Tighter, more cointegrated panel: only TIPS-derived breakevens and
    the policy rate, all denominated in % per annum, all driven by the
    same monetary/inflation regime. Fewer noise channels (no oil, USD,
    PPI, wages, shelter — those live in other strategies).
  * 5 vars instead of 7 → parameter count is O(k^2 p) so dropping two
    variables roughly halves the coefficients to estimate.
  * Sample restricted to post-2003 when the 10Y TIPS series stabilised
    and forward-rate decompositions became meaningful. Avoids dragging
    in pre-TIPS-era macro regimes the model can't represent.
  * Daily-frequency series are differenced to MoM changes — diff(level)
    is roughly stationary on these breakevens, satisfying VAR's I(0)
    assumption better than levels.

Forecast: pull CPI MoM column out of `forecast_interval(alpha=0.20)` for
the 80% bands. Aggressive try/except wrapping with a Ridge fallback and
an ultimate persistence fallback so the strategy never crashes the race.
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
_TIPS_START = "2003-01-01"    # post-TIPS-era cutoff

_TERM_IDS = ("T5YIE", "T10YIE", "T5YIFR", "FEDFUNDS")


# ----------------------------- helpers -----------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


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


def _build_term_panel(panel: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    """Build the 5-var stationary panel: CPI MoM + 4 differenced rates.

    Returns (df, target_col_name). target_col_name is the name of the
    CPI column in the returned DataFrame.
    """
    cols: dict[str, pd.Series] = {}

    # CPI MoM log-% — the column we extract from the forecast.
    cpi = panel[TARGET.fred_id]
    cols["cpi_mom"] = _log_mom(cpi)

    # Term-structure variables: take the raw level, resample to monthly
    # mean (FEDFUNDS already monthly; TIPS daily — both downsample
    # cleanly onto the panel index), then take first difference. Diff
    # rather than pct-change because these are quoted in % p.a.
    for tid in _TERM_IDS:
        if tid not in panel.columns:
            continue
        s = panel[tid].astype(float)
        cols[f"{tid}_diff"] = s - s.shift(1)

    df = pd.concat(cols, axis=1)
    df = df.replace([np.inf, -np.inf], np.nan)
    # Restrict to post-2003 — pre-TIPS data isn't comparable.
    try:
        df = df.loc[df.index >= pd.Timestamp(_TIPS_START)]
    except Exception:
        pass
    df = df.ffill(limit=2).dropna(how="any")
    return df, "cpi_mom"


# ----------------------------- strategy ----------------------------------


class TermStructureVarStrategy(ForecastStrategy):
    """5-variable VAR on (CPI MoM, T5YIE_diff, T10YIE_diff, T5YIFR_diff, FEDFUNDS_diff)."""

    name = "agent_ww_termvar"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            try:
                return self._ridge_fallback(panel, horizon)
            except Exception:
                return self._naive(panel, horizon)

    # ------------- main path: 5-var VAR with BIC lag selection -------------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Required columns gate — fall back if any are missing.
        for tid in _TERM_IDS:
            if tid not in panel.columns:
                return self._ridge_fallback(panel, horizon)

        from statsmodels.tsa.api import VAR

        df, target_col = _build_term_panel(panel)
        if df.empty or len(df) < _MIN_OBS or target_col not in df.columns:
            return self._ridge_fallback(panel, horizon)

        # Need at least all 5 columns for the term-structure VAR.
        if df.shape[1] < 5:
            return self._ridge_fallback(panel, horizon)

        Y = df.values.astype(float)
        col_names = list(df.columns)
        target_ix = col_names.index(target_col)

        try:
            model = VAR(Y)
            results = model.fit(maxlags=_MAX_LAGS, ic="bic")
        except Exception:
            try:
                results = VAR(Y).fit(1)
            except Exception:
                return self._ridge_fallback(panel, horizon)

        p = max(int(getattr(results, "k_ar", 1) or 1), 1)
        if Y.shape[0] < p + 1:
            return self._ridge_fallback(panel, horizon)

        last_obs = Y[-p:]

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
            try:
                point = np.asarray(results.forecast(y=last_obs, steps=horizon))
                if point.shape != (horizon, len(col_names)) or not np.all(
                    np.isfinite(point)
                ):
                    return self._ridge_fallback(panel, horizon)
                means = point[:, target_ix]
            except Exception:
                return self._ridge_fallback(panel, horizon)

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

        # Sanity-clip and floor interval widths.
        means_out = np.clip(means.astype(float), _MOM_LO_CLIP, _MOM_HI_CLIP)
        spreads = np.maximum(
            np.abs(his - means).astype(float),
            np.abs(means - los).astype(float),
        )
        spreads = np.maximum(spreads, _Z80 * _RESID_FLOOR)
        los_out = means_out - spreads
        his_out = means_out + spreads

        if not (
            np.all(np.isfinite(means_out))
            and np.all(np.isfinite(los_out))
            and np.all(np.isfinite(his_out))
        ):
            return self._ridge_fallback(panel, horizon)

        return means_out, los_out, his_out

    # ----------------- fallback: per-horizon Ridge -----------------

    def _ridge_fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler

        cpi = panel[TARGET.fred_id]
        y_full = _log_mom(cpi)

        rows: dict[str, pd.Series] = {
            "cpi_mom_lag1": y_full.shift(1),
            "cpi_mom_lag2": y_full.shift(2),
            "cpi_mom_lag3": y_full.shift(3),
        }
        for tid in _TERM_IDS:
            if tid in panel.columns:
                s = panel[tid].astype(float)
                rows[f"{tid}_diff_lag1"] = (s - s.shift(1)).shift(1)
                rows[f"{tid}_lvl_lag1"] = s.shift(1)

        X_full = pd.concat(rows, axis=1).replace([np.inf, -np.inf], np.nan)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        last_row = X_full.ffill(limit=2).dropna(how="any")
        if last_row.empty:
            return self._naive(panel, horizon)
        live_row = last_row.iloc[-1]

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                y_target = y_full.shift(-h).rename("y_target")
                df = X_full.join(y_target, how="inner").dropna()
                if len(df) < 36:
                    raise RuntimeError("not enough rows")
                feat_cols = [c for c in df.columns if c != "y_target"]
                X = df[feat_cols].values.astype(float)
                y = df["y_target"].values.astype(float)
                x_live = live_row[feat_cols].values.astype(float).reshape(1, -1)
                scaler = StandardScaler().fit(X)
                Xs = scaler.transform(X)
                xs_live = scaler.transform(x_live)
                model = RidgeCV(alphas=np.logspace(-3, 3, 19)).fit(Xs, y)
                yhat = float(model.predict(xs_live)[0])
                resid = y - model.predict(Xs)
                resid_std = max(float(np.std(resid)), _RESID_FLOOR)
            except Exception:
                yhat = _last_observed_mom(panel)
                resid_std = max(_empirical_mom_std(panel), 0.15)
            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread
        return means, los, his

    # --------------------- last-resort: persistence ---------------------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1, dtype=float))
        return means, means - spread, means + spread
