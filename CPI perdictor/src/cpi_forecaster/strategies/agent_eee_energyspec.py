"""Agent EEE: Energy-CPI subcomponent specialist that contributes to headline.

Energy is the noisiest CPI subcomponent and where most "surprise"
month-to-month variance comes from. The hierarchical baseline gave
each component the same Ridge treatment, but Energy actually deserves
something stronger: it has a clean, near-mechanical relationship with
WTI/Brent/retail-gas/diesel that a quantile gradient booster picks up
on more cleanly than a linear Ridge does.

This strategy builds a *specialist* model just for Energy CPI and
then plugs that specialist's forecast into the standard
component-aggregation:

    headline_pred = w_F * food_pred + w_E * energy_pred + w_C * core_pred

where
  * energy_pred  — GradientBoostingRegressor(loss="quantile", alpha=0.5)
                   fed ONLY by oil/gasoline/diesel MoM features and
                   Energy CPI's own MoM lags. Direct multi-step.
  * food_pred    — small Ridge on PPI commodity drivers + own lags.
  * core_pred    — small Ridge on wages + shelter + MICH + own lags.
  * weights      — empirical NNLS over the most recent ~60 months,
                   with a BLS prior fallback (0.13 / 0.07 / 0.80).

The 80% interval is built from the variance combination
sigma^2 = sum_i w_i^2 * sigma_i^2 (independence assumption — slightly
underestimates true correlation, so we floor the spread).

Compared to the existing `hierarchical` strategy, the difference is
purely the energy specialist: a quantile-loss GBR on a tighter
energy-only feature set tends to be substantially better at the
month-to-month gasoline shocks that drive Energy CPI swings.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET


warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_CORE_ID = "CPILFESL"

# Drivers per component. Kept small to avoid overfitting on short
# training windows for distant horizons.
_FOOD_DRIVERS = (
    "PPIACO",         # all-commodities PPI — broad upstream pressure
    "PPIFIS",         # final-demand PPI — closer to retail food
    "DCOILWTICO",     # oil — fertilizer/agri input
    "CES0500000003",  # wages — labor cost in food prep/retail
)
_ENERGY_DRIVERS = (
    "DCOILWTICO",     # WTI — direct upstream
    "DCOILBRENTEU",   # Brent — global marker, jet fuel/heating oil
    "GASREGW",        # retail regular gasoline — direct downstream
    "GASDESW",        # retail diesel — freight/distribution
)
_CORE_DRIVERS = (
    "CES0500000003",  # avg hourly earnings — wage pressure
    "CSUSHPISA",      # Case-Shiller — leading indicator for rents
    "CUSR0000SAH1",   # CPI shelter — biggest single core slice
    "MICH",           # Michigan 1Y inflation expectations
    "M2SL",           # money supply
    "UNRATE",         # labor slack
)

# BLS-published approximate relative-importance weights, used as a
# safety prior if NNLS goes off the rails.
_BLS_WEIGHTS_PRIOR = np.array([0.13, 0.07, 0.80], dtype=float)

_RIDGE_ALPHAS = np.logspace(-3, 3, 13)
_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.85,
    min_samples_leaf=5,
    random_state=0,
)

_Z80 = 1.2816
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (
        np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))
    ) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _three_mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(3) - 1.0) * 100.0


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


def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    feats = X_full.copy()
    feats = feats.ffill(limit=2)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


# ---------------------------------------------------------------------------
# Feature builders — one tight feature set per component.
# ---------------------------------------------------------------------------

def _build_energy_specialist_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Energy-only feature matrix for the GBR specialist.

    Includes Energy CPI's own MoM lags 1/2/3 plus, for each oil/gas
    driver, MoM lag-1 and 3-month change lag-1. Calendar harmonics
    too — gasoline has a strong residual summer pattern.
    """
    rows: dict[str, pd.Series] = {}

    # Own lags (autoregressive anchor).
    energy = panel[_ENERGY_ID]
    e_mom = _log_mom(energy)
    rows[f"{_ENERGY_ID}_mom_lag1"] = e_mom.shift(1)
    rows[f"{_ENERGY_ID}_mom_lag2"] = e_mom.shift(2)
    rows[f"{_ENERGY_ID}_mom_lag3"] = e_mom.shift(3)
    rows[f"{_ENERGY_ID}_yoy_lag1"] = _yoy(energy).shift(1)

    # Per-driver MoM and 3mo features.
    for sid in _ENERGY_DRIVERS:
        if sid not in panel.columns:
            continue
        col = panel[sid].astype(float)
        rows[f"{sid}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{sid}_3mo_lag1"] = _three_mo(col).shift(1)

    # Calendar — small but cheap.
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx, name="month_sin"
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx, name="month_cos"
    )

    feats = pd.concat(rows, axis=1)
    return feats.replace([np.inf, -np.inf], np.nan)


def _build_food_features(panel: pd.DataFrame) -> pd.DataFrame:
    rows: dict[str, pd.Series] = {}
    food = panel[_FOOD_ID]
    f_mom = _log_mom(food)
    rows[f"{_FOOD_ID}_mom_lag1"] = f_mom.shift(1)
    rows[f"{_FOOD_ID}_mom_lag2"] = f_mom.shift(2)
    rows[f"{_FOOD_ID}_mom_lag3"] = f_mom.shift(3)
    rows[f"{_FOOD_ID}_yoy_lag1"] = _yoy(food).shift(1)

    for sid in _FOOD_DRIVERS:
        if sid not in panel.columns:
            continue
        col = panel[sid].astype(float)
        rows[f"{sid}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{sid}_3mo_lag1"] = _three_mo(col).shift(1)

    return pd.concat(rows, axis=1).replace([np.inf, -np.inf], np.nan)


def _build_core_features(panel: pd.DataFrame) -> pd.DataFrame:
    rows: dict[str, pd.Series] = {}
    core = panel[_CORE_ID]
    c_mom = _log_mom(core)
    rows[f"{_CORE_ID}_mom_lag1"] = c_mom.shift(1)
    rows[f"{_CORE_ID}_mom_lag2"] = c_mom.shift(2)
    rows[f"{_CORE_ID}_mom_lag3"] = c_mom.shift(3)
    rows[f"{_CORE_ID}_yoy_lag1"] = _yoy(core).shift(1)

    for sid in _CORE_DRIVERS:
        if sid not in panel.columns:
            continue
        col = panel[sid].astype(float)
        rows[f"{sid}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{sid}_3mo_lag1"] = _three_mo(col).shift(1)

    return pd.concat(rows, axis=1).replace([np.inf, -np.inf], np.nan)


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class EnergySpecialistStrategy(ForecastStrategy):
    """Energy-specialist GBR + Food/Core Ridges, aggregated to headline."""

    name = "agent_eee_energyspec"

    # ------------------------------------------------------------------
    # Public entry
    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ------------------------------------------------------------------
    # Main path: per-component forecasts then weighted aggregation
    # ------------------------------------------------------------------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # If subcomponents are missing, degrade to the naive path.
        for cid in (_FOOD_ID, _ENERGY_ID, _CORE_ID, TARGET.fred_id):
            if cid not in panel.columns:
                return self._naive(panel, horizon)

        # ---- Energy specialist (GBR-quantile median) ----
        try:
            e_means, e_stds = self._fit_energy_specialist(panel, horizon)
        except Exception:
            e_means, e_stds = self._component_naive(panel, _ENERGY_ID, horizon)

        # ---- Food (Ridge) ----
        try:
            f_means, f_stds = self._fit_ridge_component(
                panel, _FOOD_ID, _build_food_features, horizon
            )
        except Exception:
            f_means, f_stds = self._component_naive(panel, _FOOD_ID, horizon)

        # ---- Core (Ridge) ----
        try:
            c_means, c_stds = self._fit_ridge_component(
                panel, _CORE_ID, _build_core_features, horizon
            )
        except Exception:
            c_means, c_stds = self._component_naive(panel, _CORE_ID, horizon)

        # ---- Weights (NNLS on recent ~60 months, BLS prior fallback) ----
        weights = self._estimate_weights(panel)
        w_f, w_e, w_c = float(weights[0]), float(weights[1]), float(weights[2])

        # ---- Aggregate to headline ----
        head_mean = w_f * f_means + w_e * e_means + w_c * c_means

        # Variance combination assuming independence — slightly under-
        # estimates true correlation so we floor the spread.
        head_var = (
            (w_f**2) * (f_stds**2)
            + (w_e**2) * (e_stds**2)
            + (w_c**2) * (c_stds**2)
        )
        head_std = np.sqrt(np.maximum(head_var, 0.0))
        head_std = np.maximum(head_std, _RESID_FLOOR)

        # Clip means to a sane MoM range.
        head_mean = np.clip(head_mean, _MOM_LO_CLIP, _MOM_HI_CLIP)
        spread = _Z80 * head_std
        lo = head_mean - spread
        hi = head_mean + spread

        if not np.isfinite(head_mean).all():
            return self._naive(panel, horizon)

        return head_mean.astype(float), lo.astype(float), hi.astype(float)

    # ------------------------------------------------------------------
    # Energy specialist: GBR with quantile loss alpha=0.5, direct multi-step
    # ------------------------------------------------------------------
    def _fit_energy_specialist(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray]:
        from sklearn.ensemble import GradientBoostingRegressor

        X_full = _build_energy_specialist_features(panel)
        y_full = _log_mom(panel[_ENERGY_ID]).rename("y_target")
        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        stds = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                y_target = y_full.shift(-h).rename("y_target")
                df = X_full.join(y_target, how="inner").dropna()
                if len(df) < _MIN_TRAIN_ROWS:
                    raise RuntimeError("not enough training rows")

                feature_cols = [c for c in df.columns if c != "y_target"]
                X = df[feature_cols].values.astype(float)
                y = df["y_target"].values.astype(float)
                x_live = (
                    live_row[feature_cols].values.astype(float).reshape(1, -1)
                )

                gbr = GradientBoostingRegressor(
                    loss="quantile", alpha=0.5, **_GBR_PARAMS
                ).fit(X, y)
                yhat = float(gbr.predict(x_live)[0])
                resid = y - gbr.predict(X)
                sd = float(np.std(resid))
                if not np.isfinite(sd):
                    sd = 0.30
                sd = max(sd, _RESID_FLOOR)
            except Exception:
                yhat, sd = self._component_naive_one(panel, _ENERGY_ID)
            means[i] = yhat
            stds[i] = sd

        return means, stds

    # ------------------------------------------------------------------
    # Generic Ridge component (Food / Core), direct multi-step
    # ------------------------------------------------------------------
    def _fit_ridge_component(
        self,
        panel: pd.DataFrame,
        component_id: str,
        feature_builder,
        horizon: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        X_full = feature_builder(panel)
        y_full = _log_mom(panel[component_id]).rename("y_target")
        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        stds = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                y_target = y_full.shift(-h).rename("y_target")
                df = X_full.join(y_target, how="inner").dropna()
                if len(df) < _MIN_TRAIN_ROWS:
                    raise RuntimeError("not enough training rows")

                feature_cols = [c for c in df.columns if c != "y_target"]
                X = df[feature_cols].values.astype(float)
                y = df["y_target"].values.astype(float)
                x_live = (
                    live_row[feature_cols].values.astype(float).reshape(1, -1)
                )

                scaler = StandardScaler().fit(X)
                Xs = scaler.transform(X)
                x_live_s = scaler.transform(x_live)

                n_splits = min(5, max(2, len(df) // 60))
                try:
                    ridge = RidgeCV(
                        alphas=_RIDGE_ALPHAS,
                        cv=TimeSeriesSplit(n_splits=n_splits),
                    ).fit(Xs, y)
                except Exception:
                    ridge = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xs, y)

                yhat = float(ridge.predict(x_live_s)[0])
                resid = y - ridge.predict(Xs)
                sd = float(np.std(resid))
                if not np.isfinite(sd):
                    sd = 0.30
                sd = max(sd, _RESID_FLOOR)
            except Exception:
                yhat, sd = self._component_naive_one(panel, component_id)
            means[i] = yhat
            stds[i] = sd

        return means, stds

    # ------------------------------------------------------------------
    # Weight estimation (NNLS on the recent ~60 months)
    # ------------------------------------------------------------------
    def _estimate_weights(self, panel: pd.DataFrame) -> np.ndarray:
        try:
            head = _log_mom(panel[TARGET.fred_id]).rename("head")
            food = _log_mom(panel[_FOOD_ID]).rename("food")
            ener = _log_mom(panel[_ENERGY_ID]).rename("ener")
            core = _log_mom(panel[_CORE_ID]).rename("core")
            df = pd.concat([head, food, ener, core], axis=1).dropna()
            if len(df) < 24:
                return _BLS_WEIGHTS_PRIOR.copy()

            df = df.tail(60)
            X = df[["food", "ener", "core"]].values.astype(float)
            y = df["head"].values.astype(float)

            # NNLS — non-negative least squares.
            w: np.ndarray | None = None
            try:
                from scipy.optimize import nnls

                w_arr, _ = nnls(X, y)
                w = np.asarray(w_arr, dtype=float)
            except Exception:
                w = None

            # Fallback to non-negative Ridge if scipy.nnls is unavailable.
            if w is None or not np.isfinite(w).all():
                try:
                    from sklearn.linear_model import Ridge
                    model = Ridge(
                        alpha=1e-3, positive=True, fit_intercept=False
                    )
                    model.fit(X, y)
                    w = np.asarray(model.coef_, dtype=float)
                except Exception:
                    w = None

            if w is None or not np.isfinite(w).all():
                try:
                    coefs, *_ = np.linalg.lstsq(X, y, rcond=None)
                    w = np.asarray(coefs, dtype=float)
                except Exception:
                    return _BLS_WEIGHTS_PRIOR.copy()

            w = np.clip(w, 0.0, None)
            ws = float(w.sum())
            if not np.isfinite(ws) or ws < 1e-6:
                return _BLS_WEIGHTS_PRIOR.copy()
            w = w / ws

            # Sanity guardrails — blend toward BLS prior if implausible.
            if w[2] > 0.95 or w[2] < 0.5 or w[0] < 0.02 or w[1] < 0.005:
                w = 0.5 * w + 0.5 * _BLS_WEIGHTS_PRIOR
                w = w / float(w.sum())
            return w
        except Exception:
            return _BLS_WEIGHTS_PRIOR.copy()

    # ------------------------------------------------------------------
    # Per-component naive fallback
    # ------------------------------------------------------------------
    @staticmethod
    def _component_naive(
        panel: pd.DataFrame, component_id: str, horizon: int
    ) -> tuple[np.ndarray, np.ndarray]:
        try:
            s = _log_mom(panel[component_id]).dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        except Exception:
            last, sd = 0.0, 0.30
        sd = max(sd, _RESID_FLOOR)
        return (
            np.full(horizon, last, dtype=float),
            np.full(horizon, sd, dtype=float),
        )

    @staticmethod
    def _component_naive_one(
        panel: pd.DataFrame, component_id: str
    ) -> tuple[float, float]:
        try:
            s = _log_mom(panel[component_id]).dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        except Exception:
            last, sd = 0.0, 0.30
        return last, max(sd, _RESID_FLOOR)

    # ------------------------------------------------------------------
    # Whole-strategy naive fallback
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
