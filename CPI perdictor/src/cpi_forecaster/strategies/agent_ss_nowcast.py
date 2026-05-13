"""Agent SS — Cleveland Fed nowcast replicator.

The Cleveland Fed's monthly inflation nowcast is one of the more
respected real-time CPI predictors. Its architecture combines a few
distinct signals: a "core trend" anchor from the Cleveland Median CPI,
a market-implied inflation gauge from TIPS breakevens, and a direct
mechanical pass-through from energy spot prices (oil/retail gasoline).
Housing components show up indirectly via shelter inertia.

This strategy replicates that architecture in a lightweight, panel-only
form. We build three independent sub-forecasters per horizon, then
combine them with inverse-error weights estimated from a short rolling
inner backtest over the most recent ~24 months. 80% bands come from
the std of the combined model's residuals on that same inner window
(with a sensible floor to avoid overconfidence).

Sub-forecasters
---------------
  (a) Median-anchor:
      Predict headline MoM as
          y_hat = E[median MoM at h] + spread_hat
      where E[median MoM at h] is a tiny Ridge of the Cleveland Median
      CPI MoM on its own short lags (very inertial — usually close to
      its trailing average), and spread_hat is a Ridge of the headline-
      minus-median spread regressed on recent oil and gasoline MoM
      changes (these capture the transitory "noise" in headline that
      median strips out by construction).

  (b) Breakeven-anchor:
      The 5Y TIPS breakeven (T5YIE) is an annualized inflation rate;
      to convert it into headline MoM space we estimate
          scale = mean(headline_yoy / 12) / mean(T5YIE)
      over the trailing 60 months, then predict
          y_hat = T5YIE_lag1 * scale + tilt
      where `tilt` is the recent residual mean (last 12 months) so the
      forecaster tracks short-term level shifts that breakevens miss.

  (c) Direct multi-step Ridge:
      A traditional small Ridge using CPI lags + headline drivers
      (oil, gas, shelter YoY, wages YoY, housing starts MoM, MICH).
      This is the fallback voice if the other two anchors disagree
      noisily — Ridge with TimeSeriesSplit-CV alpha and a StandardScaler.

Combination
-----------
For each horizon h we run a 24-month walk-forward inner backtest of
all three sub-forecasters and compute MAE. Weights are
    w_k = (1 / (mae_k + eps)) / sum_j (1 / (mae_j + eps))
A sub-forecaster that fails the inner backtest gets weight 0; if all
three fail, we fall back to the last observed MoM.

The combined residual std (from the inner backtest, 80% z=1.2816)
sets the band width, with a floor of 0.10pp.

Robustness
----------
Every entry point is wrapped in try/except. If the panel lacks the
required series (median CPI, T5YIE, oil) the corresponding sub-
forecaster is silently dropped from the combination. If everything
fails, we return a naive last-MoM forecast — never crashes the race.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET


warnings.filterwarnings("ignore")


# --------------------------- constants ---------------------------------

_Z80 = 1.2816
_MIN_TRAIN_ROWS = 36
_INNER_BT_WINDOW = 24      # months in inner walk-forward for weights
_RESID_FLOOR = 0.10        # floor on residual std (pp)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_EPS = 1e-6
_TILT_LOOKBACK = 12

# FRED series IDs the strategy reads.
_MEDIAN_ID = "MEDCPIM158SFRBCLE"
_T5YIE_ID = "T5YIE"
_WTI_ID = "DCOILWTICO"
_GAS_ID = "GASREGW"
_HOUST_ID = "HOUST"
# Direct-Ridge supporting series (best-effort).
_SHELTER_ID = "CUSR0000SAH1"
_WAGES_ID = "CES0500000003"
_MICH_ID = "MICH"


# --------------------------- helpers ----------------------------------


def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _mom_pct(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy_pct(s: pd.Series) -> pd.Series:
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


def _fit_ridge(
    X: np.ndarray, y: np.ndarray, x_live: np.ndarray
) -> tuple[float, np.ndarray]:
    """Simple time-series-CV Ridge. Returns (point pred, in-sample resid)."""
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)
    x_live_s = scaler.transform(x_live)
    n_splits = min(5, max(2, len(X) // 60))
    alphas = np.logspace(-3, 3, 19)
    try:
        tscv = TimeSeriesSplit(n_splits=n_splits)
        ridge = RidgeCV(alphas=alphas, cv=tscv).fit(Xs, y)
    except Exception:
        ridge = RidgeCV(alphas=alphas).fit(Xs, y)
    pred = float(ridge.predict(x_live_s)[0])
    resid = y - ridge.predict(Xs)
    return pred, resid


# ---------------------- sub-forecaster: median-anchor ---------------------


def _build_median_anchor_inputs(panel: pd.DataFrame) -> dict | None:
    """Return assembled series needed for the median-anchor pipeline,
    or None if the panel is missing what we need."""
    cols = panel.columns
    if _MEDIAN_ID not in cols:
        return None
    if panel[_MEDIAN_ID].dropna().shape[0] < 36:
        return None

    cpi = panel[TARGET.fred_id]
    headline_mom = _log_mom(cpi)
    median_mom = _mom_pct(panel[_MEDIAN_ID])

    # Spread features: oil & gas MoM (lagged) — these are the proxy for
    # the transitory noise that separates headline from median.
    feats: dict[str, pd.Series] = {}
    if _WTI_ID in cols:
        feats["wti_mom_lag1"] = _mom_pct(panel[_WTI_ID]).shift(1)
        feats["wti_mom_lag2"] = _mom_pct(panel[_WTI_ID]).shift(2)
    if _GAS_ID in cols:
        feats["gas_mom_lag1"] = _mom_pct(panel[_GAS_ID]).shift(1)
        feats["gas_mom_lag2"] = _mom_pct(panel[_GAS_ID]).shift(2)
    # Median own lags help predict the next median print.
    feats["med_mom_lag1"] = median_mom.shift(1)
    feats["med_mom_lag2"] = median_mom.shift(2)
    feats["med_mom_lag3"] = median_mom.shift(3)

    if not feats:
        return None
    feat_df = pd.concat(feats, axis=1).replace([np.inf, -np.inf], np.nan)
    return {
        "headline_mom": headline_mom,
        "median_mom": median_mom,
        "feats": feat_df,
    }


def _median_anchor_predict(
    inputs: dict, h: int, cut_idx: int | None = None
) -> float | None:
    """One-shot prediction at horizon h from the median-anchor pipeline.

    `cut_idx` lets the inner backtest "freeze" data at a past point —
    when None, we use the full panel up to the latest available row.
    """
    headline = inputs["headline_mom"]
    median = inputs["median_mom"]
    feats = inputs["feats"]

    # Restrict to data up to cut_idx (exclusive of future). For the live
    # call, cut_idx is None and we use everything available.
    if cut_idx is not None:
        headline = headline.iloc[:cut_idx]
        median = median.iloc[:cut_idx]
        feats = feats.iloc[:cut_idx]

    # ---- predict median MoM at h via Ridge of median own lags ----
    med_target = median.shift(-h).rename("y_med")
    df_m = feats.join(med_target, how="inner").dropna()
    if len(df_m) < _MIN_TRAIN_ROWS:
        return None
    feat_cols_m = [c for c in df_m.columns if c != "y_med"]
    Xm = df_m[feat_cols_m].values.astype(float)
    ym = df_m["y_med"].values.astype(float)

    feats_live = feats.ffill(limit=2)
    feats_live = feats_live.fillna(feats_live.mean(numeric_only=True)).dropna()
    if feats_live.empty:
        return None
    x_live_m = feats_live[feat_cols_m].iloc[-1].values.astype(float).reshape(1, -1)
    try:
        med_pred, _ = _fit_ridge(Xm, ym, x_live_m)
    except Exception:
        return None

    # ---- predict headline-minus-median spread at h via Ridge on oil/gas ----
    spread = (headline - median).rename("y_sprd")
    sprd_target = spread.shift(-h).rename("y_sprd")
    # For spread we want oil/gas lags (already in feats); reuse same matrix.
    df_s = feats.join(sprd_target, how="inner").dropna()
    if len(df_s) < _MIN_TRAIN_ROWS:
        spread_pred = float(spread.dropna().tail(_TILT_LOOKBACK).mean())
    else:
        feat_cols_s = [c for c in df_s.columns if c != "y_sprd"]
        Xs = df_s[feat_cols_s].values.astype(float)
        ys = df_s["y_sprd"].values.astype(float)
        x_live_s = feats_live[feat_cols_s].iloc[-1].values.astype(float).reshape(1, -1)
        try:
            spread_pred, _ = _fit_ridge(Xs, ys, x_live_s)
        except Exception:
            spread_pred = float(spread.dropna().tail(_TILT_LOOKBACK).mean())

    return float(med_pred + spread_pred)


# ---------------------- sub-forecaster: breakeven-anchor ------------------


def _build_breakeven_anchor_inputs(panel: pd.DataFrame) -> dict | None:
    cols = panel.columns
    if _T5YIE_ID not in cols:
        return None
    if panel[_T5YIE_ID].dropna().shape[0] < 36:
        return None

    cpi = panel[TARGET.fred_id]
    headline_mom = _log_mom(cpi)
    headline_yoy = _yoy_pct(cpi)
    breakeven = panel[_T5YIE_ID].astype(float)

    return {
        "headline_mom": headline_mom,
        "headline_yoy": headline_yoy,
        "breakeven": breakeven,
    }


def _breakeven_anchor_predict(
    inputs: dict, h: int, cut_idx: int | None = None
) -> float | None:
    headline_mom = inputs["headline_mom"]
    headline_yoy = inputs["headline_yoy"]
    breakeven = inputs["breakeven"]

    if cut_idx is not None:
        headline_mom = headline_mom.iloc[:cut_idx]
        headline_yoy = headline_yoy.iloc[:cut_idx]
        breakeven = breakeven.iloc[:cut_idx]

    # ---- estimate scale: convert annual breakeven into MoM space ----
    # YoY/12 ≈ avg MoM. Compare its mean to mean breakeven over a tail.
    df = pd.concat(
        {"yoy": headline_yoy, "be": breakeven}, axis=1
    ).dropna()
    if df.empty:
        return None
    tail = df.tail(60)
    if len(tail) < 24:
        return None
    mean_mom = float(tail["yoy"].mean()) / 12.0
    mean_be = float(tail["be"].mean())
    if abs(mean_be) < 1e-3:
        return None
    scale = mean_mom / mean_be
    if not np.isfinite(scale):
        return None

    # Latest breakeven at the cut.
    be_now = float(breakeven.dropna().iloc[-1]) if breakeven.dropna().size else None
    if be_now is None:
        return None
    base = be_now * scale  # MoM-space prediction from the breakeven level

    # ---- tilt: average residual (actual - base) over recent months ----
    # The breakeven level reads slowly; the tilt recovers the short-term
    # bias the level alone misses.
    recent_mom = headline_mom.tail(_TILT_LOOKBACK).dropna()
    recent_be = breakeven.reindex(recent_mom.index).ffill()
    if len(recent_mom) < 6:
        tilt = 0.0
    else:
        residuals = recent_mom.values - (recent_be.values * scale)
        tilt = float(np.nanmean(residuals)) if np.isfinite(np.nanmean(residuals)) else 0.0

    # The breakeven anchor returns the same prediction at every horizon —
    # it's a regime read, not a path. That's fine: the combiner blends it
    # with the path-aware sub-forecasters and weights it by performance.
    return base + tilt


# ---------------------- sub-forecaster: direct Ridge ----------------------


def _build_direct_inputs(panel: pd.DataFrame) -> dict | None:
    cols = panel.columns
    if TARGET.fred_id not in cols:
        return None

    cpi = panel[TARGET.fred_id]
    headline_mom = _log_mom(cpi)

    feats: dict[str, pd.Series] = {}
    feats["cpi_mom_lag1"] = headline_mom.shift(1)
    feats["cpi_mom_lag2"] = headline_mom.shift(2)
    feats["cpi_mom_lag3"] = headline_mom.shift(3)
    feats["cpi_yoy_lag1"] = _yoy_pct(cpi).shift(1)

    if _WTI_ID in cols:
        feats["wti_mom_lag1"] = _mom_pct(panel[_WTI_ID]).shift(1)
        feats["wti_3mo_lag1"] = (
            (panel[_WTI_ID] / panel[_WTI_ID].shift(3) - 1.0) * 100.0
        ).shift(1)
    if _GAS_ID in cols:
        feats["gas_mom_lag1"] = _mom_pct(panel[_GAS_ID]).shift(1)
    if _SHELTER_ID in cols:
        feats["shelter_yoy_lag1"] = _yoy_pct(panel[_SHELTER_ID]).shift(1)
    if _WAGES_ID in cols:
        feats["wages_yoy_lag1"] = _yoy_pct(panel[_WAGES_ID]).shift(1)
    if _HOUST_ID in cols:
        feats["houst_mom_lag1"] = _mom_pct(panel[_HOUST_ID]).shift(1)
        feats["houst_yoy_lag1"] = _yoy_pct(panel[_HOUST_ID]).shift(1)
    if _MICH_ID in cols:
        feats["mich_yoy_lag1"] = _yoy_pct(panel[_MICH_ID]).shift(1)

    # Calendar — residual seasonality.
    idx = panel.index
    feats["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx
    )
    feats["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx
    )

    feat_df = pd.concat(feats, axis=1).replace([np.inf, -np.inf], np.nan)
    return {"headline_mom": headline_mom, "feats": feat_df}


def _direct_predict(
    inputs: dict, h: int, cut_idx: int | None = None
) -> float | None:
    headline = inputs["headline_mom"]
    feats = inputs["feats"]

    if cut_idx is not None:
        headline = headline.iloc[:cut_idx]
        feats = feats.iloc[:cut_idx]

    target = headline.shift(-h).rename("y")
    df = feats.join(target, how="inner").dropna()
    if len(df) < _MIN_TRAIN_ROWS:
        return None

    feat_cols = [c for c in df.columns if c != "y"]
    X = df[feat_cols].values.astype(float)
    y = df["y"].values.astype(float)

    feats_live = feats.ffill(limit=2)
    feats_live = feats_live.fillna(feats_live.mean(numeric_only=True)).dropna()
    if feats_live.empty:
        return None
    x_live = feats_live[feat_cols].iloc[-1].values.astype(float).reshape(1, -1)

    try:
        pred, _ = _fit_ridge(X, y, x_live)
    except Exception:
        return None
    return float(pred)


# ----------------------------- strategy --------------------------------


class NowcastReplicatorStrategy(ForecastStrategy):
    """Cleveland-Fed-style three-anchor blend with inverse-error weights."""

    name = "agent_ss_nowcast"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---- main path ----
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        cpi = panel[TARGET.fred_id]
        y_full = _log_mom(cpi)
        if y_full.dropna().shape[0] < _MIN_TRAIN_ROWS:
            return self._naive(panel, horizon)

        # Pre-build sub-forecaster inputs once (they don't depend on h).
        med_inputs = _build_median_anchor_inputs(panel)
        be_inputs = _build_breakeven_anchor_inputs(panel)
        dir_inputs = _build_direct_inputs(panel)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            yhat, resid_std = self._predict_one_horizon(
                y_full, med_inputs, be_inputs, dir_inputs, h
            )
            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ---- per-horizon: run inner backtest, derive weights, predict ----
    def _predict_one_horizon(
        self,
        y_full: pd.Series,
        med_inputs: dict | None,
        be_inputs: dict | None,
        dir_inputs: dict | None,
        h: int,
    ) -> tuple[float, float]:
        # Run a small inner walk-forward backtest to score each
        # sub-forecaster on the most recent _INNER_BT_WINDOW months.
        n = len(y_full)
        # We need cut_idx points where:
        #   - features at cut_idx-1 are usable, and
        #   - the realized target y_full[cut_idx-1+h] exists.
        # Walk the most recent _INNER_BT_WINDOW such cuts.
        max_cut = n - h  # last cut where target is observed
        first_cut = max(_MIN_TRAIN_ROWS + 12, max_cut - _INNER_BT_WINDOW)
        cuts = list(range(first_cut, max_cut + 1))

        med_errs: list[float] = []
        be_errs: list[float] = []
        dir_errs: list[float] = []
        med_preds: list[float] = []
        be_preds: list[float] = []
        dir_preds: list[float] = []
        actuals: list[float] = []

        for c in cuts:
            try:
                actual = float(y_full.iloc[c - 1 + h])
            except Exception:
                continue
            if not np.isfinite(actual):
                continue
            actuals.append(actual)

            mp = _safe_call(_median_anchor_predict, med_inputs, h, c) if med_inputs else None
            bp = _safe_call(_breakeven_anchor_predict, be_inputs, h, c) if be_inputs else None
            dp = _safe_call(_direct_predict, dir_inputs, h, c) if dir_inputs else None

            if mp is not None and np.isfinite(mp):
                med_preds.append(mp)
                med_errs.append(abs(mp - actual))
            if bp is not None and np.isfinite(bp):
                be_preds.append(bp)
                be_errs.append(abs(bp - actual))
            if dp is not None and np.isfinite(dp):
                dir_preds.append(dp)
                dir_errs.append(abs(dp - actual))

        # Live predictions (cut_idx=None → use everything).
        live_med = _safe_call(_median_anchor_predict, med_inputs, h, None) if med_inputs else None
        live_be = _safe_call(_breakeven_anchor_predict, be_inputs, h, None) if be_inputs else None
        live_dir = _safe_call(_direct_predict, dir_inputs, h, None) if dir_inputs else None

        # Compose inverse-error weights. Sub-forecasters with no inner
        # backtest data fall back to a small but nonzero default weight
        # (so they still contribute if they produced a live prediction).
        candidates: list[tuple[float, float, list[float], float]] = []
        # (live_pred, weight, errs_for_resid, mae)
        if live_med is not None and np.isfinite(live_med):
            mae = float(np.mean(med_errs)) if med_errs else 0.5
            candidates.append((float(live_med), 1.0 / (mae + _EPS), med_errs, mae))
        if live_be is not None and np.isfinite(live_be):
            mae = float(np.mean(be_errs)) if be_errs else 0.5
            candidates.append((float(live_be), 1.0 / (mae + _EPS), be_errs, mae))
        if live_dir is not None and np.isfinite(live_dir):
            mae = float(np.mean(dir_errs)) if dir_errs else 0.5
            candidates.append((float(live_dir), 1.0 / (mae + _EPS), dir_errs, mae))

        if not candidates:
            yhat = _last_observed_mom_from_y(y_full)
            resid_std = max(_empirical_mom_std_from_y(y_full), _RESID_FLOOR)
            return yhat, resid_std

        weights = np.array([c[1] for c in candidates], dtype=float)
        weights = weights / weights.sum()
        preds = np.array([c[0] for c in candidates], dtype=float)
        yhat = float(np.dot(weights, preds))

        # Combined residual std: weighted std of per-cut residuals across
        # the inner backtest, computed by combining each cut's available
        # sub-forecaster preds with the same weighting scheme.
        combined_residuals = self._combined_residuals(
            actuals, med_preds, be_preds, dir_preds,
            med_errs, be_errs, dir_errs,
            cuts, candidates,
        )
        if combined_residuals:
            resid_std = float(np.std(combined_residuals))
            if not np.isfinite(resid_std):
                resid_std = _empirical_mom_std_from_y(y_full)
        else:
            resid_std = _empirical_mom_std_from_y(y_full)
        resid_std = max(resid_std, _RESID_FLOOR)

        return yhat, resid_std

    # ---- residuals of the *combined* model on the inner backtest ----
    @staticmethod
    def _combined_residuals(
        actuals: list[float],
        med_preds: list[float],
        be_preds: list[float],
        dir_preds: list[float],
        med_errs: list[float],
        be_errs: list[float],
        dir_errs: list[float],
        cuts: list[int],
        candidates: list[tuple],
    ) -> list[float]:
        # Re-run the inner cuts with each sub-forecaster's *known* preds
        # at that cut, then combine using the same MAE-driven weights.
        # Note: we only collected per-cut preds for sub-forecasters that
        # produced a finite output, so re-align by cut index. To keep
        # this O(N) and avoid a second pass, we simply weight the live
        # candidates' per-cut errors directly.
        if not actuals:
            return []
        # Use only sub-forecasters that had any candidate slot.
        # Reconstruct a "combined error" per cut as the weighted sum of
        # absolute errors (a conservative proxy for the combined std).
        # Each candidate holds (live_pred, weight, errs, mae); sum the
        # weighted absolute errors to get an upper-bound resid magnitude.
        per_cut_errs: list[float] = []
        max_len = 0
        weighted_err_lists: list[tuple[float, list[float]]] = []
        total_w = sum(c[1] for c in candidates)
        if total_w <= 0:
            return []
        for live_pred, w, errs, mae in candidates:
            if not errs:
                continue
            weighted_err_lists.append((w / total_w, errs))
            max_len = max(max_len, len(errs))
        if not weighted_err_lists:
            return []
        # Average across candidates per index — when a candidate's errs
        # is shorter, fall back to its mean for missing indices.
        for k in range(max_len):
            total = 0.0
            for w_norm, errs in weighted_err_lists:
                if k < len(errs):
                    total += w_norm * errs[k]
                else:
                    total += w_norm * float(np.mean(errs))
            per_cut_errs.append(total)
        return per_cut_errs

    # ---- naive fallback ----
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread


# --- small free helpers reused above (avoid passing `self` around) ---


def _last_observed_mom_from_y(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std_from_y(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())


def _safe_call(fn, *args, **kwargs):
    """Call sub-forecaster, swallowing any exception → returns None."""
    try:
        return fn(*args, **kwargs)
    except Exception:
        return None
