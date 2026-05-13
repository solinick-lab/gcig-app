"""Agent NN: Energy multiplexer.

The macro panel ships four distinct energy series, and they're not
redundant — each reads a different stage of the energy-to-CPI
transmission:

  * DCOILWTICO  — WTI spot. The classic US headline barrel.
  * DCOILBRENTEU — Brent spot. Imported energy and the global marker
    that products like jet fuel, heating oil and shipping price off.
    The WTI-Brent spread also doubles as a USD-strength / pipeline-
    capacity proxy.
  * GASREGW — retail regular gasoline. Closest to consumer wallets;
    moves with WTI but with a multi-week pass-through lag and a
    sticky-down asymmetry. Flows directly into CPI Energy.
  * GASDESW — retail diesel. Drives freight, distribution and farming
    costs; the diesel-vs-gasoline spread is a clean read of trucking
    pressure feeding into goods-and-food CPI.

So instead of throwing them at a kitchen-sink model, this strategy
multiplexes them: pick a small, energy-only feature set built from
their MoM/3-mo lags and a couple of regime/spread terms, plus a few
standard CPI lags as the autoregressive anchor. Train a direct
multi-step Ridge + XGB ensemble at each horizon.

If any of the four series are missing from the panel, we degrade
gracefully — features that depend on a missing series are simply
dropped before training.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET


warnings.filterwarnings("ignore")


# --------------------------- constants ----------------------------------

_Z80 = 1.2816
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36

# Regime thresholds in level units of the underlying series.
_WTI_STRESS_USD = 90.0   # $/bbl
_DIESEL_STRESS_USD = 4.0  # $/gal retail

_ENERGY_IDS = ("DCOILWTICO", "DCOILBRENTEU", "GASREGW", "GASDESW")


# --------------------------- helpers ------------------------------------


def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


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


def _xgb_params() -> dict:
    return dict(
        n_estimators=300,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=3,
        reg_lambda=1.0,
        reg_alpha=0.05,
        objective="reg:squarederror",
        n_jobs=1,
        verbosity=0,
        random_state=0,
    )


def _ridge_alphas() -> np.ndarray:
    return np.logspace(-3, 3, 19)


# ---------------------- feature construction ---------------------------


def _build_energy_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Energy-only feature matrix.

    Adds CPI MoM lags 1/2/3 as the AR anchor, then a per-energy-series
    block of MoM-lag-1 and 3mo-lag-1 plus two cross terms (WTI-Brent
    spread, diesel-gasoline spread) and a binary stress flag.
    Missing series are tolerated: any feature whose underlying series
    isn't present is simply omitted.
    """
    rows: dict[str, pd.Series] = {}

    # ---- CPI lags (AR anchor) ----
    cpi = panel[TARGET.fred_id]
    cpi_mom = _log_mom(cpi)
    rows["cpi_mom_lag1"] = cpi_mom.shift(1)
    rows["cpi_mom_lag2"] = cpi_mom.shift(2)
    rows["cpi_mom_lag3"] = cpi_mom.shift(3)

    # ---- Per-series MoM/3mo lag-1 features ----
    for sid in _ENERGY_IDS:
        if sid not in panel.columns:
            continue
        col = panel[sid].astype(float)
        rows[f"{sid}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{sid}_3mo_lag1"] = _three_mo(col).shift(1)

    # ---- Cross / spread features ----
    # WTI-Brent spread in level USD/bbl (positive when WTI premium).
    if {"DCOILWTICO", "DCOILBRENTEU"}.issubset(panel.columns):
        wti = panel["DCOILWTICO"].astype(float)
        brent = panel["DCOILBRENTEU"].astype(float)
        rows["wti_minus_brent_lag1"] = (wti - brent).shift(1)

    # Diesel-gasoline spread in level USD/gal (freight pressure proxy).
    if {"GASDESW", "GASREGW"}.issubset(panel.columns):
        diesel = panel["GASDESW"].astype(float)
        gas = panel["GASREGW"].astype(float)
        rows["diesel_minus_gas_lag1"] = (diesel - gas).shift(1)

    # ---- Energy stress regime flag ----
    flag = pd.Series(0.0, index=panel.index)
    if "DCOILWTICO" in panel.columns:
        flag = flag + (panel["DCOILWTICO"].astype(float) > _WTI_STRESS_USD).astype(float)
    if "GASDESW" in panel.columns:
        flag = flag + (panel["GASDESW"].astype(float) > _DIESEL_STRESS_USD).astype(float)
    # OR semantics: 1 if either condition holds.
    flag = (flag > 0).astype(float)
    rows["energy_stress_lag1"] = flag.shift(1)

    feats = pd.concat(rows, axis=1)
    feats = feats.replace([np.inf, -np.inf], np.nan)
    return feats


# ----------------------------- strategy --------------------------------


class EnergyMultiplexStrategy(ForecastStrategy):
    """Energy-only feature panel + direct multi-step Ridge/XGB ensemble."""

    name = "agent_nn_energy"

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
        # Bail out entirely if no energy series at all are present —
        # the strategy has nothing distinctive to offer in that case.
        if not any(sid in panel.columns for sid in _ENERGY_IDS):
            return self._naive(panel, horizon)

        X_full = _build_energy_features(panel)
        cpi = panel[TARGET.fred_id]
        y_full = _log_mom(cpi).rename("y_target")

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat = _last_observed_mom(panel)
                resid_std = max(_empirical_mom_std(panel), _RESID_FLOOR)
            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ---- per-horizon Ridge + XGB ----
    def _fit_one_horizon(
        self,
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
        if len(df) < _MIN_TRAIN_ROWS:
            raise RuntimeError("not enough training rows")

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # Ridge w/ TimeSeriesSplit-CV alpha.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)
        n_splits = min(5, max(2, len(df) // 60))
        try:
            ridge = RidgeCV(
                alphas=_ridge_alphas(),
                cv=TimeSeriesSplit(n_splits=n_splits),
            ).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=_ridge_alphas()).fit(Xs, y)
        ridge_pred = float(ridge.predict(x_live_s)[0])
        ridge_resid = y - ridge.predict(Xs)

        # XGB (best-effort).
        xgb_pred: float | None = None
        xgb_resid: np.ndarray | None = None
        try:
            from xgboost import XGBRegressor

            model = XGBRegressor(**_xgb_params()).fit(X, y)
            xgb_pred = float(model.predict(x_live)[0])
            xgb_resid = y - model.predict(X)
        except Exception:
            xgb_pred = None
            xgb_resid = None

        if xgb_pred is None:
            yhat = ridge_pred
            resid = ridge_resid
        else:
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        resid_std = float(np.std(resid))
        if not np.isfinite(resid_std):
            resid_std = 0.20
        resid_std = max(resid_std, _RESID_FLOOR)
        return yhat, resid_std

    # ---- helpers ----
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

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
