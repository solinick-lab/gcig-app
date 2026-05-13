"""Hierarchical (component-aggregation) CPI forecaster.

BLS publishes headline CPI as the weighted sum of subcomponents — Food
(~13%), Energy (~7%), and Core (less food + energy, ~80%). Each
component has very different drivers: Energy moves with crude/gasoline
in days; Core is dominated by sticky shelter and wages; Food sits in
between, driven by upstream commodity producer prices.

Forecasting headline directly forces a single model to reconcile all
those signals at once. Forecasting components separately and
aggregating typically wins by 10-20% RMSE (Cleveland Fed / Atlanta
Fed both do this in production). This strategy implements that pattern:

  1. For each subcomponent, build a component-specific feature matrix
     using only the drivers that economically belong (oil/gas for
     Energy, wages/shelter/M2 for Core, PPI/oil for Food).
  2. Train a small Ridge per (component, horizon) — direct multi-step,
     so no compounding error.
  3. Estimate Food/Energy/Core weights empirically from the past ~60
     months of MoM histories: headline_MoM = w_F*food_MoM + w_E*energy
     + w_C*core_MoM. Constrain to non-negative; renormalize to 1.
  4. Aggregate: headline_pred = sum_i w_i * component_pred_i.
  5. Intervals: combine component residual stds via the (independence)
     formula sigma^2 = sum w_i^2 * sigma_i^2 — a slight under-estimate
     of true correlation but pragmatic and stable.

Falls back gracefully (subcomponent missing in panel, fit fails, etc.)
to a Ridge on headline only, then to last-observed MoM.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import SUBCOMPONENTS, TARGET


warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# Driver lists per component. Picked for economic relevance — see module
# docstring. We keep them small to avoid Ridge overfitting on ~36-row
# training windows for distant horizons.
# ---------------------------------------------------------------------------
_FOOD_DRIVERS = (
    "PPIACO",       # all-commodities PPI — broad upstream pressure
    "PPIFIS",       # final-demand PPI — closer to retail food
    "DCOILWTICO",   # oil — logistics + fertilizer/agri input
    "CES0500000003",  # wages — labor cost in food prep/retail
)
_ENERGY_DRIVERS = (
    "DCOILWTICO",   # WTI — direct upstream
    "GASREGW",      # retail gasoline — direct downstream proxy
    "DTWEXBGS",     # USD broad — oil priced in dollars
)
_CORE_DRIVERS = (
    "CES0500000003",   # avg hourly earnings — wage pressure
    "CSUSHPISA",       # Case-Shiller — leading indicator for rents
    "CUSR0000SAH1",    # CPI shelter — biggest single core slice
    "MICH",            # Michigan 1Y inflation expectations
    "M2SL",            # money supply
    "UNRATE",          # labor slack
    "DGS10",           # 10Y yield — nominal rate stance
)


_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_CORE_ID = "CPILFESL"

# Order matters — we use this same ordering for weight estimation and
# aggregation. Maps component fred_id to its driver tuple.
_COMPONENTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (_FOOD_ID, _FOOD_DRIVERS),
    (_ENERGY_ID, _ENERGY_DRIVERS),
    (_CORE_ID, _CORE_DRIVERS),
)

# BLS-published approximate relative-importance weights — used as a
# fallback prior if the empirical least-squares estimate goes off the
# rails (negative coefs that don't recover after clipping, etc.).
_BLS_WEIGHTS_PRIOR = np.array([0.13, 0.07, 0.80], dtype=float)


_RIDGE_ALPHAS = np.logspace(-3, 3, 13)
_Z80 = 1.2816


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _build_component_features(
    panel: pd.DataFrame, component_id: str, driver_ids: tuple[str, ...]
) -> pd.DataFrame:
    """Lagged feature matrix for a single CPI component.

    Includes the component's own MoM lags 1/2/3 plus, for each driver,
    a MoM lag-1, a 3-month change lag-1, and a YoY lag-1. All
    information is shifted so that row T uses only data available by
    end of month T-1.
    """
    rows: dict[str, pd.Series] = {}
    comp = panel[component_id]
    rows[f"{component_id}_mom_lag1"] = _log_mom(comp).shift(1)
    rows[f"{component_id}_mom_lag2"] = _log_mom(comp).shift(2)
    rows[f"{component_id}_mom_lag3"] = _log_mom(comp).shift(3)
    rows[f"{component_id}_yoy_lag1"] = _yoy(comp).shift(1)

    for did in driver_ids:
        if did not in panel.columns:
            continue
        d = panel[did]
        rows[f"{did}_mom_lag1"] = _mom(d).shift(1)
        rows[f"{did}_3mo_lag1"] = ((d / d.shift(3) - 1.0) * 100.0).shift(1)
        rows[f"{did}_yoy_lag1"] = _yoy(d).shift(1)

    # Calendar — small but cheap, helps Energy in particular (gasoline
    # has a strong summer pattern that survives the seasonal adjustment).
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx, name="month_sin"
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx, name="month_cos"
    )

    return pd.concat(rows, axis=1)


def _component_target(panel: pd.DataFrame, component_id: str) -> pd.Series:
    return _log_mom(panel[component_id]).rename("y_target")


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class HierarchicalStrategy(ForecastStrategy):
    name = "hierarchical"

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._hierarchical(panel, horizon)
        except Exception:
            return self._fallback_headline(panel, horizon)

    # ------------------------------------------------------------------
    # Main hierarchical path
    # ------------------------------------------------------------------
    def _hierarchical(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Sanity-check that all subcomponents exist; older panels may
        # not include them. If any are missing we degrade to the
        # headline-only ridge fallback.
        comp_ids = [c.fred_id for c in SUBCOMPONENTS]
        if not all(cid in panel.columns for cid in comp_ids):
            return self._fallback_headline(panel, horizon)
        if TARGET.fred_id not in panel.columns:
            return self._fallback_headline(panel, horizon)

        # Per-component, per-horizon forecasts + residual stds.
        # Shape: 3 components x H horizons.
        comp_means = np.zeros((len(_COMPONENTS), horizon), dtype=float)
        comp_stds = np.zeros((len(_COMPONENTS), horizon), dtype=float)
        any_component_failed = False

        for ci, (cid, drivers) in enumerate(_COMPONENTS):
            try:
                m, s = self._fit_component_all_horizons(
                    panel, cid, drivers, horizon
                )
            except Exception:
                # If a component blows up, we fall back to its last
                # observed MoM for every horizon and a wide-ish std.
                any_component_failed = True
                m, s = self._component_naive_forecast(panel, cid, horizon)
            comp_means[ci, :] = m
            comp_stds[ci, :] = s

        # Estimate weights from the recent past, with a safety net.
        weights = self._estimate_weights(panel)

        # Aggregate to headline.
        head_mean = weights @ comp_means  # shape (horizon,)
        # Independence-assumption variance combination. Real components
        # are positively correlated, so this slightly under-estimates
        # variance — we floor the spread below to compensate.
        head_var = (weights**2) @ (comp_stds**2)
        head_std = np.sqrt(np.maximum(head_var, 0.0))
        head_std = np.maximum(head_std, 0.10)  # floor

        spread = _Z80 * head_std
        lo = head_mean - spread
        hi = head_mean + spread

        # If everything failed structurally, fall back; otherwise return
        # the aggregated forecast.
        if any_component_failed and not np.isfinite(head_mean).all():
            return self._fallback_headline(panel, horizon)

        return head_mean, lo, hi

    # ------------------------------------------------------------------
    # Per-component direct multi-step Ridge
    # ------------------------------------------------------------------
    def _fit_component_all_horizons(
        self,
        panel: pd.DataFrame,
        component_id: str,
        driver_ids: tuple[str, ...],
        horizon: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Train a Ridge per horizon for one component. Returns
        (means, resid_stds), each shape (horizon,)."""
        X_full = _build_component_features(panel, component_id, driver_ids)
        y_full = _component_target(panel, component_id)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        stds = np.empty(horizon, dtype=float)
        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, sd = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat, sd = self._component_naive_one(panel, component_id)
            means[i] = yhat
            stds[i] = sd
        return means, stds

    @staticmethod
    def _fit_one_horizon(
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            # Not enough data — naive fallback at this horizon.
            last_y = y_full.dropna()
            yhat = float(last_y.iloc[-1]) if not last_y.empty else 0.0
            sd = float(last_y.tail(60).std()) if len(last_y) >= 12 else 0.30
            return yhat, max(sd, 0.10)

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=_RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xs, y)
        yhat = float(ridge.predict(x_live_s)[0])
        resid = y - ridge.predict(Xs)
        sd = float(np.std(resid))
        return yhat, max(sd, 0.10)

    # ------------------------------------------------------------------
    # Weight estimation (Food / Energy / Core)
    # ------------------------------------------------------------------
    def _estimate_weights(self, panel: pd.DataFrame) -> np.ndarray:
        """Recover the empirical weights of each component in headline
        from the most recent ~60 months of MoM histories.

        We use a small ridge with non-negative output (clip + renorm).
        sklearn 1.0+ supports Ridge(positive=True), but we don't want
        to depend on a specific version, so we just clip and renormalize
        — a clean fallback if the OLS solution has a small negative.
        Falls back to BLS published weights ~ (0.13, 0.07, 0.80) if
        the panel is too short or the fit explodes.
        """
        try:
            head = _log_mom(panel[TARGET.fred_id]).rename("head")
            food = _log_mom(panel[_FOOD_ID]).rename("food")
            ener = _log_mom(panel[_ENERGY_ID]).rename("ener")
            core = _log_mom(panel[_CORE_ID]).rename("core")
            df = pd.concat([head, food, ener, core], axis=1).dropna()
            if len(df) < 24:
                return _BLS_WEIGHTS_PRIOR.copy()

            # Use the most recent ~60 months — weights drift, so we
            # don't want decade-old spending shares dominating.
            df = df.tail(60)
            X = df[["food", "ener", "core"]].values.astype(float)
            y = df["head"].values.astype(float)

            # Try non-negative ridge first if available.
            w: np.ndarray | None = None
            try:
                from sklearn.linear_model import Ridge
                model = Ridge(alpha=1e-3, positive=True, fit_intercept=False)
                model.fit(X, y)
                w = np.asarray(model.coef_, dtype=float)
            except Exception:
                w = None

            if w is None or not np.isfinite(w).all():
                # Fall back to plain OLS via lstsq.
                try:
                    coefs, *_ = np.linalg.lstsq(X, y, rcond=None)
                    w = np.asarray(coefs, dtype=float)
                except Exception:
                    return _BLS_WEIGHTS_PRIOR.copy()

            # Clip + renormalize to a probability vector.
            w = np.clip(w, 0.0, None)
            ws = float(w.sum())
            if not np.isfinite(ws) or ws < 1e-6:
                return _BLS_WEIGHTS_PRIOR.copy()
            w = w / ws

            # Sanity guardrails: no single weight should dominate
            # absurdly (e.g. core >0.99 from a degenerate fit) or
            # collapse Food/Energy to zero. If they look implausible,
            # blend toward the BLS prior 50/50.
            if w[2] > 0.95 or w[2] < 0.5 or w[0] < 0.02 or w[1] < 0.005:
                w = 0.5 * w + 0.5 * _BLS_WEIGHTS_PRIOR
                w = w / float(w.sum())
            return w
        except Exception:
            return _BLS_WEIGHTS_PRIOR.copy()

    # ------------------------------------------------------------------
    # Naive per-component fallback (when one component's pipeline fails)
    # ------------------------------------------------------------------
    @staticmethod
    def _component_naive_forecast(
        panel: pd.DataFrame, component_id: str, horizon: int
    ) -> tuple[np.ndarray, np.ndarray]:
        try:
            s = _log_mom(panel[component_id]).dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        except Exception:
            last, sd = 0.0, 0.30
        sd = max(sd, 0.10)
        return np.full(horizon, last, dtype=float), np.full(horizon, sd, dtype=float)

    @staticmethod
    def _component_naive_one(panel: pd.DataFrame, component_id: str) -> tuple[float, float]:
        try:
            s = _log_mom(panel[component_id]).dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        except Exception:
            last, sd = 0.0, 0.30
        return last, max(sd, 0.10)

    # ------------------------------------------------------------------
    # Latest-feature-row helper (matches agent_b_direct convention)
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    # ------------------------------------------------------------------
    # Whole-strategy fallback: Ridge on headline only, no components
    # ------------------------------------------------------------------
    def _fallback_headline(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Used when subcomponents are missing or the hierarchical
        path fails entirely. Mirrors the baseline ridge: build the
        standard feature matrix on the full panel and run a single
        direct-multi-step Ridge per horizon.
        """
        try:
            from ..features import build_features, build_target

            X_full = build_features(panel)
            y_full = build_target(panel)
            live_row = self._latest_feature_row(X_full)

            means = np.empty(horizon, dtype=float)
            los = np.empty(horizon, dtype=float)
            his = np.empty(horizon, dtype=float)
            for i, h in enumerate(range(1, horizon + 1)):
                try:
                    yhat, sd = self._fit_one_horizon(X_full, y_full, h, live_row)
                except Exception:
                    yhat, sd = self._component_naive_one(panel, TARGET.fred_id)
                spread = _Z80 * sd
                means[i] = yhat
                los[i] = yhat - spread
                his[i] = yhat + spread
            return means, los, his
        except Exception:
            # Absolute last resort: last-observed MoM with sqrt(h) widening.
            try:
                y = _log_mom(panel[TARGET.fred_id]).dropna()
                last = float(y.iloc[-1]) if not y.empty else 0.0
                sd = float(y.tail(60).std()) if len(y) >= 12 else 0.30
            except Exception:
                last, sd = 0.0, 0.30
            sd = max(sd, 0.15)
            means = np.full(horizon, last, dtype=float)
            spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
            return means, means - spread, means + spread
