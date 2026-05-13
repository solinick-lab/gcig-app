"""Agent Y - Markov regime-switching CPI forecaster.

Classical Hamilton (1989) approach: assume CPI MoM follows a regression where
the coefficients (and crucially the residual variance) switch between K hidden
regimes that follow a Markov chain. The two natural regimes for inflation are:

  - LOW-VOL "anchored" regime: small, stable MoM moves (post-1990s, 2014-2019).
  - HIGH-VOL "shock" regime: oil/COVID/2022 burst, large noisy MoM swings.

The model jointly estimates the regression coefficients in each regime and the
regime transition probabilities. At forecast time we mix regime-conditional
forecasts by the smoothed regime probability of the last observation, so we
inherit whichever regime we're currently in.

Why a small exog set: Markov fits are notoriously fragile. With ~200 monthly
obs and switching variance, even ~5 exogenous covariates can blow up the
likelihood (parameter identification, label switching, local optima). We pick
the five most economically obvious leading indicators for headline CPI:
  - Oil MoM (energy passthrough)
  - PPI All-Commodities MoM (upstream price pressure)
  - Shelter MoM (the largest, stickiest CPI subcomponent)
  - Wages YoY (services inflation)
  - Michigan 1Y inflation expectations (level, not change)

CONVERGENCE: MarkovRegression often raises LinAlgError or non-convergence
warnings. We try in order:
  1) k=2, switching_variance=True with the standard exog set
  2) k=2, switching_variance=False (variance pooled)
  3) AR(3) on y alone (no regime switching, no exog)
  4) Last-MoM persistence

The fit_and_predict contract MUST NOT raise — every level above is a try/except.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target
from ..fred import TARGET


# Exog series picked by hand. Must all exist in the FEATURES list.
# (We compute their lagged MoM/YoY/level transformations ourselves below.)
_EXOG_SPEC = [
    ("DCOILWTICO", "mom"),    # oil MoM %
    ("PPIACO", "mom"),        # PPI all-commodities MoM %
    ("CUSR0000SAH1", "mom"),  # CPI shelter MoM %
    ("CES0500000003", "yoy"), # avg hourly earnings YoY %
    ("MICH", "level"),        # Michigan 1Y inflation expectations (already a %)
]


def _persistence_forecast(panel: pd.DataFrame, horizon: int):
    """Last observed MoM repeated. Final fallback if everything else fails."""
    try:
        last = float(build_target(panel).dropna().iloc[-1])
    except Exception:
        last = 0.20  # ~2.4% annualized prior
    m = np.array([last] * horizon)
    return m, m - 0.30, m + 0.30


def _build_exog(panel: pd.DataFrame) -> pd.DataFrame:
    """Lagged exog matrix, aligned to panel.index. Lag-1 so PIT-safe."""
    cols: dict[str, pd.Series] = {}
    for fid, kind in _EXOG_SPEC:
        if fid not in panel.columns:
            continue
        s = panel[fid]
        if kind == "mom":
            v = (s / s.shift(1) - 1.0) * 100.0
        elif kind == "yoy":
            v = (s / s.shift(12) - 1.0) * 100.0
        else:  # "level"
            v = s.astype(float)
        cols[f"{fid}_{kind}"] = v.shift(1)  # lag 1 -> available at month T
    if not cols:
        return pd.DataFrame(index=panel.index)
    return pd.concat(cols, axis=1)


def _ar_fallback_forecast(y: pd.Series, horizon: int):
    """AR(3) on y. Used when MarkovRegression won't converge."""
    from statsmodels.tsa.ar_model import AutoReg

    y_clean = y.dropna()
    # Need at least ~24 obs to fit AR(3) sensibly.
    if len(y_clean) < 24:
        raise RuntimeError("not enough obs for AR fallback")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        res = AutoReg(y_clean.values, lags=3, old_names=False).fit()
    fc = np.asarray(res.forecast(steps=horizon), dtype=float)
    resid = np.asarray(res.resid, dtype=float)
    sigma = float(np.std(resid)) if len(resid) > 0 else 0.25
    z = 1.2816  # 80% two-sided
    spread = z * max(sigma, 1e-6) * np.sqrt(np.arange(1, horizon + 1))
    return fc, fc - spread, fc + spread


class MarkovRegimeStrategy(ForecastStrategy):
    name = "agent_y_markov"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._run(panel, horizon)
        except Exception:
            try:
                y = build_target(panel)
                return _ar_fallback_forecast(y, horizon)
            except Exception:
                return _persistence_forecast(panel, horizon)

    # ------------------------------------------------------------------
    def _run(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Lazy import — statsmodels is heavy and we want clean isolation
        # if it's not installed.
        from statsmodels.tsa.regime_switching.markov_regression import (
            MarkovRegression,
        )

        # 1) Target.
        y_full = build_target(panel)

        # 2) Exog matrix, aligned + dropped jointly with y.
        X_full = _build_exog(panel)

        if X_full.shape[1] == 0:
            # No exog available — fall through to AR fallback.
            return _ar_fallback_forecast(y_full, horizon)

        df = X_full.join(y_full.rename("__y"), how="inner").dropna()
        # Need a meaningful sample for a 2-regime fit with switching variance.
        # ~5-7 params per regime + 2 transition probs => want at least 60 obs.
        if len(df) < 60:
            return _ar_fallback_forecast(y_full, horizon)

        y_train = df["__y"].astype(float)
        X_train = df.drop(columns=["__y"]).astype(float)

        # 3) Try the rich Markov fit first, then progressively simpler.
        means_arr, lo, hi = self._try_markov(
            y_train, X_train, panel, horizon, switching_variance=True
        ) or (None, None, None)
        if means_arr is None:
            means_arr, lo, hi = self._try_markov(
                y_train, X_train, panel, horizon, switching_variance=False
            ) or (None, None, None)
        if means_arr is None:
            # Both Markov fits failed — caller's outer try will catch and fall
            # through to AR / persistence.
            raise RuntimeError("Markov regression failed to converge")
        return means_arr, lo, hi

    # ------------------------------------------------------------------
    def _try_markov(
        self,
        y_train: pd.Series,
        X_train: pd.DataFrame,
        panel: pd.DataFrame,
        horizon: int,
        switching_variance: bool,
    ):
        """One MarkovRegression attempt. Returns None on any failure."""
        from statsmodels.tsa.regime_switching.markov_regression import (
            MarkovRegression,
        )

        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                model = MarkovRegression(
                    endog=y_train.values,
                    k_regimes=2,
                    exog=X_train.values,
                    switching_variance=switching_variance,
                )
                # disp=False suppresses optimizer chatter; em_iter starts MLE
                # from a few EM steps which dramatically improves convergence.
                res = model.fit(disp=False, em_iter=10, search_reps=5)
        except Exception:
            return None

        # Sanity check the fit didn't silently produce NaNs.
        try:
            sm_probs = np.asarray(res.smoothed_marginal_probabilities)
            # statsmodels returns shape (T, k) in newer versions and (k, T) in
            # older — handle both.
            if sm_probs.ndim != 2:
                return None
            if sm_probs.shape[0] == 2 and sm_probs.shape[1] != 2:
                sm_probs = sm_probs.T
            last_probs = sm_probs[-1]
            if not np.all(np.isfinite(last_probs)):
                return None
        except Exception:
            return None

        # 4) Forecast. Hold exog flat at the last observed row (a defensible
        # short-horizon assumption — these are slow-moving macro inputs).
        try:
            last_row = X_train.iloc[-1].values.astype(float)
            exog_future = np.tile(last_row, (horizon, 1))
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                fc = np.asarray(
                    res.forecast(steps=horizon, exog=exog_future), dtype=float
                )
        except Exception:
            return None

        if fc.shape[0] != horizon or not np.all(np.isfinite(fc)):
            return None

        # 5) Bands: residual std weighted by current-regime probability.
        try:
            resid = np.asarray(res.resid, dtype=float)
            if resid.ndim == 2:
                # Some statsmodels versions return per-regime residuals;
                # collapse with smoothed probs.
                # Align shapes defensively.
                if resid.shape[0] == sm_probs.shape[0]:
                    blended = (resid * sm_probs).sum(axis=1)
                else:
                    blended = resid.mean(axis=1)
            else:
                blended = resid

            # Per-regime variance estimate, then mix by last regime prob.
            if switching_variance:
                # Try to get the regime-specific variances out of the params.
                try:
                    sigma2_regime = np.array(
                        [
                            float(res.params.get(f"sigma2[{k}]", np.nan))
                            for k in range(2)
                        ]
                    )
                    if not np.all(np.isfinite(sigma2_regime)):
                        sigma2_regime = None
                except Exception:
                    sigma2_regime = None
                if sigma2_regime is not None:
                    sigma2_now = float(np.dot(last_probs, sigma2_regime))
                else:
                    sigma2_now = float(np.var(blended))
            else:
                sigma2_now = float(np.var(blended))
            sigma_now = float(np.sqrt(max(sigma2_now, 1e-8)))
        except Exception:
            sigma_now = 0.25  # sane default for monthly CPI MoM in %

        z = 1.2816  # 80%
        spread = z * sigma_now * np.sqrt(np.arange(1, horizon + 1))
        return fc, fc - spread, fc + spread
