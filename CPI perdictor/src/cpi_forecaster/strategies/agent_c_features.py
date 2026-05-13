"""Agent C: sophisticated feature engineering strategy.

Builds a richer feature matrix than the baseline, drawing on signals
that economists actually look at for inflation prediction:
  - PPI-CPI spread (cost passthrough leading indicator)
  - Oil/gas momentum * level interactions (asymmetric passthrough)
  - Shelter inflation 6-mo MA (rents are sticky)
  - Wage-price spiral indicator (AHE YoY minus core CPI YoY proxy)
  - M2 growth proxy
  - Inflation expectations level AND change (MICH and Delta-MICH)
  - USD index 6-month change (import price passthrough)
  - Realized CPI volatility regime indicator
  - 10Y real-rate proxy
  - Quadratic oil/gas terms (non-linear passthrough)
  - Crisis dummy: above-median 12-mo CPI vol

Trains Ridge + XGBoost on the rich panel, recursive multi-step.
Combines the two via inverse-RMSE weights (with equal-weight fallback).
80% intervals from training residual std, scaled by sqrt(h).

Defensive: fit_and_predict NEVER raises; failures fall back to a
last-observed MoM forecast.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import FEATURES, TARGET


# ----------------------------- Helpers ---------------------------------

def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    # Add a tiny floor to avoid log(0) blowups on noisy series.
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _pct_change_n(s: pd.Series, n: int) -> pd.Series:
    return (s / s.shift(n) - 1.0) * 100.0


def _diff_n(s: pd.Series, n: int) -> pd.Series:
    return s - s.shift(n)


# --------------------- Rich feature construction ----------------------

def _build_rich_features(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Build the enriched feature matrix and aligned target.

    Target: log MoM % change in CPI (stationary, chains nicely).
    """
    rows: dict[str, pd.Series] = {}

    cpi = panel[TARGET.fred_id]
    cpi_mom = _log_mom(cpi)
    target = cpi_mom.rename("y_mom_pct")
    cpi_yoy = _yoy(cpi)

    # ---- CPI own-history features (lagged) ----
    rows["cpi_mom_lag1"] = cpi_mom.shift(1)
    rows["cpi_mom_lag2"] = cpi_mom.shift(2)
    rows["cpi_mom_lag3"] = cpi_mom.shift(3)
    rows["cpi_mom_lag6"] = cpi_mom.shift(6)
    rows["cpi_mom_lag12"] = cpi_mom.shift(12)
    rows["cpi_yoy_lag1"] = cpi_yoy.shift(1)
    # 3-mo and 6-mo MoM averages (smoothed momentum, less noisy than single-month)
    rows["cpi_mom_avg3_lag1"] = cpi_mom.rolling(3).mean().shift(1)
    rows["cpi_mom_avg6_lag1"] = cpi_mom.rolling(6).mean().shift(1)
    # Acceleration: change in 3-mo trend vs prior 3-mo trend
    rows["cpi_mom_accel_lag1"] = (
        cpi_mom.rolling(3).mean() - cpi_mom.rolling(3).mean().shift(3)
    ).shift(1)

    # ---- Realized CPI volatility (regime) ----
    cpi_vol_12 = cpi_mom.rolling(12).std()
    rows["cpi_vol12_lag1"] = cpi_vol_12.shift(1)
    # Crisis dummy: 12-mo vol exceeds expanding-window median (point-in-time, no leakage)
    long_run_median = cpi_vol_12.expanding(min_periods=24).median()
    crisis = (cpi_vol_12 > long_run_median).astype(float)
    rows["cpi_vol_regime_lag1"] = crisis.shift(1)

    # ---- Per-series lag-1 standard transforms (mom/3mo/yoy) ----
    series_cache: dict[str, pd.Series] = {}
    for f in FEATURES:
        col = panel[f.fred_id]
        series_cache[f.fred_id] = col
        rows[f"{f.fred_id}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{f.fred_id}_3mo_lag1"] = _pct_change_n(col, 3).shift(1)
        rows[f"{f.fred_id}_yoy_lag1"] = _yoy(col).shift(1)

    # ---- PPI-CPI spread (cost passthrough leading indicator) ----
    if "PPIACO" in panel.columns:
        ppi_yoy = _yoy(panel["PPIACO"])
        rows["ppi_cpi_spread_lag1"] = (ppi_yoy - cpi_yoy).shift(1)
        # 3-mo change in the spread (is passthrough pressure rising?)
        rows["ppi_cpi_spread_chg3_lag1"] = (
            (ppi_yoy - cpi_yoy) - (ppi_yoy - cpi_yoy).shift(3)
        ).shift(1)
    if "PPIFIS" in panel.columns:
        ppifis_yoy = _yoy(panel["PPIFIS"])
        rows["ppifis_cpi_spread_lag1"] = (ppifis_yoy - cpi_yoy).shift(1)

    # ---- Oil & gas: momentum * level (asymmetric passthrough) ----
    # Hypothesis: a 10% oil rise off $80 hits CPI harder than off $30.
    if "DCOILWTICO" in panel.columns:
        oil = panel["DCOILWTICO"]
        oil_mom = _mom(oil)
        oil_3mo = _pct_change_n(oil, 3)
        # Standardize the level for interaction (z-score using expanding stats)
        oil_level_z = (oil - oil.expanding(min_periods=24).mean()) / (
            oil.expanding(min_periods=24).std().replace(0, np.nan)
        )
        rows["oil_mom_x_level_lag1"] = (oil_mom * oil_level_z).shift(1)
        rows["oil_3mo_x_level_lag1"] = (oil_3mo * oil_level_z).shift(1)
        # Quadratic in MoM (non-linear passthrough)
        rows["oil_mom_sq_lag1"] = (oil_mom.pow(2) * np.sign(oil_mom)).shift(1)
        # 6-month change (medium-term oil cycle)
        rows["oil_6mo_lag1"] = _pct_change_n(oil, 6).shift(1)
    if "GASREGW" in panel.columns:
        gas = panel["GASREGW"]
        gas_mom = _mom(gas)
        rows["gas_mom_sq_lag1"] = (gas_mom.pow(2) * np.sign(gas_mom)).shift(1)
        rows["gas_3mo_lag1_extra"] = _pct_change_n(gas, 3).shift(1)

    # ---- Shelter: 6-mo MA of MoM (rents are sticky/slow) ----
    if "CUSR0000SAH1" in panel.columns:
        shelter = panel["CUSR0000SAH1"]
        shelter_mom = _mom(shelter)
        rows["shelter_mom_ma6_lag1"] = shelter_mom.rolling(6).mean().shift(1)
        rows["shelter_mom_ma12_lag1"] = shelter_mom.rolling(12).mean().shift(1)
        # Shelter trend acceleration
        rows["shelter_accel_lag1"] = (
            shelter_mom.rolling(3).mean() - shelter_mom.rolling(3).mean().shift(3)
        ).shift(1)

    # ---- Home prices: passthrough into shelter is delayed (~12-18 mo) ----
    if "CSUSHPISA" in panel.columns:
        hpi_yoy = _yoy(panel["CSUSHPISA"])
        rows["hpi_yoy_lag12"] = hpi_yoy.shift(12)
        rows["hpi_yoy_lag18"] = hpi_yoy.shift(18)

    # ---- Wage-price spiral: AHE YoY minus CPI YoY (real wage pressure, inverted) ----
    if "CES0500000003" in panel.columns:
        ahe_yoy = _yoy(panel["CES0500000003"])
        rows["wage_price_spread_lag1"] = (ahe_yoy - cpi_yoy).shift(1)
        # When wages are rising fast and labor market tight, persistent inflation
        if "UNRATE" in panel.columns:
            unrate = panel["UNRATE"]
            # Slack-adjusted wage pressure: high wages * low unemployment
            rows["wage_x_tightness_lag1"] = (
                ahe_yoy * (10.0 - unrate)
            ).shift(1)

    # ---- M2 growth (monetary impulse) ----
    if "M2SL" in panel.columns:
        m2 = panel["M2SL"]
        rows["m2_yoy_lag1"] = _yoy(m2).shift(1)
        rows["m2_3mo_lag1"] = _pct_change_n(m2, 3).shift(1)
        # M2 growth velocity proxy: M2 growth interacted with industrial production growth
        if "INDPRO" in panel.columns:
            indpro_yoy = _yoy(panel["INDPRO"])
            rows["m2_x_indpro_lag1"] = (_yoy(m2) * indpro_yoy).shift(1)

    # ---- Inflation expectations: LEVEL and CHANGE ----
    # Both matter — anchored expectations vs un-anchoring is a different signal
    if "MICH" in panel.columns:
        mich = panel["MICH"]
        rows["mich_level_lag1"] = mich.shift(1)
        rows["mich_chg3_lag1"] = _diff_n(mich, 3).shift(1)
        rows["mich_chg6_lag1"] = _diff_n(mich, 6).shift(1)
        # MICH minus realized CPI YoY: are expectations above or below realized?
        rows["mich_vs_cpi_lag1"] = (mich - cpi_yoy).shift(1)

    # ---- USD index: import price passthrough ----
    if "DTWEXBGS" in panel.columns:
        usd = panel["DTWEXBGS"]
        rows["usd_chg6_lag1"] = _pct_change_n(usd, 6).shift(1)
        rows["usd_chg12_lag1"] = _pct_change_n(usd, 12).shift(1)
        # Stronger dollar = lower import prices, lagged effect
        rows["usd_chg6_lag6"] = _pct_change_n(usd, 6).shift(6)

    # ---- 10Y real-rate proxy (10Y minus realized CPI YoY) ----
    if "DGS10" in panel.columns:
        dgs10 = panel["DGS10"]
        rows["real_rate_proxy_lag1"] = (dgs10 - cpi_yoy).shift(1)
        rows["dgs10_chg6_lag1"] = _diff_n(dgs10, 6).shift(1)

    # ---- Industrial production / retail sales: demand pressure ----
    if "INDPRO" in panel.columns:
        indpro = panel["INDPRO"]
        rows["indpro_3mo_lag1"] = _pct_change_n(indpro, 3).shift(1)
    if "RSAFS" in panel.columns:
        rsafs = panel["RSAFS"]
        rows["rsafs_3mo_lag1"] = _pct_change_n(rsafs, 3).shift(1)

    # ---- Unemployment gap-style features ----
    if "UNRATE" in panel.columns:
        unrate = panel["UNRATE"]
        # Deviation from 5-year (60-mo) trailing mean — slack/tightness gap
        unrate_trend = unrate.rolling(60, min_periods=24).mean()
        rows["unrate_gap_lag1"] = (unrate - unrate_trend).shift(1)
        rows["unrate_chg6_lag1"] = _diff_n(unrate, 6).shift(1)

    # ---- Calendar (residual seasonality) ----
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx
    )

    feats = pd.concat(rows, axis=1)
    # Replace inf with NaN; we'll drop incomplete rows later.
    feats = feats.replace([np.inf, -np.inf], np.nan)

    return feats, target


def _supervised(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    X, y = _build_rich_features(panel)
    df = X.join(y, how="inner").dropna()
    return df.drop(columns=["y_mom_pct"]), df["y_mom_pct"]


def _last_usable_row(panel: pd.DataFrame, feature_cols: list[str]) -> pd.Series:
    """Most recent feature row for prediction. Forward-fills tiny ragged-edge gaps."""
    X, _ = _build_rich_features(panel)
    X = X[feature_cols].copy()
    X = X.ffill(limit=3)
    X = X.dropna(how="any")
    if X.empty:
        raise RuntimeError("No usable feature row after ragged-edge ffill.")
    return X.iloc[-1]


def _roll_cpi_lags(feat_row: pd.Series, yhat: float) -> pd.Series:
    """Roll the CPI-own-history lag features forward by one month.

    Macro features stay frozen at last observed value (naive but robust).
    """
    fr = feat_row.copy()
    if "cpi_mom_lag12" in fr.index and "cpi_mom_lag6" in fr.index:
        fr["cpi_mom_lag12"] = fr.get("cpi_mom_lag12", 0.0)  # frozen approximation
    if "cpi_mom_lag6" in fr.index:
        fr["cpi_mom_lag6"] = fr.get("cpi_mom_lag6", 0.0)
    if "cpi_mom_lag3" in fr.index and "cpi_mom_lag2" in fr.index:
        fr["cpi_mom_lag3"] = fr["cpi_mom_lag2"]
    if "cpi_mom_lag2" in fr.index and "cpi_mom_lag1" in fr.index:
        fr["cpi_mom_lag2"] = fr["cpi_mom_lag1"]
    if "cpi_mom_lag1" in fr.index:
        fr["cpi_mom_lag1"] = yhat
    # Approximate update to smoothed momentum features
    if "cpi_mom_avg3_lag1" in fr.index:
        # Average of previous-three: yhat (as new lag1) + old lag1, lag2 -> use the rolled values
        prev = [
            fr.get("cpi_mom_lag1", yhat),
            fr.get("cpi_mom_lag2", yhat),
            fr.get("cpi_mom_lag3", yhat),
        ]
        fr["cpi_mom_avg3_lag1"] = float(np.nanmean(prev))
    return fr


# --------------------------- The strategy -----------------------------

class EnrichedFeaturesStrategy(ForecastStrategy):
    name = "agent_c_features"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            # Last-resort fallback: persistence on the most recent MoM.
            try:
                cpi = panel[TARGET.fred_id]
                last = float(_log_mom(cpi).dropna().iloc[-1])
            except Exception:
                last = 0.2  # ~2.4% annualized — rough long-run average
            mean = np.array([last] * horizon, dtype=float)
            spread = 0.30 * np.sqrt(np.arange(1, horizon + 1))
            return mean, mean - spread, mean + spread

    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler

        X, y = _supervised(panel)
        if len(y) < 60:
            # Not enough history for a sensible fit — fall through to fallback.
            raise RuntimeError("Insufficient training rows for enriched features.")

        feature_cols = list(X.columns)

        # ---- Ridge ----
        ridge_mean = None
        ridge_resid_std = 0.0
        try:
            scaler = StandardScaler().fit(X.values)
            Xs = scaler.transform(X.values)
            ridge = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Xs, y.values)
            ridge_resid = y.values - ridge.predict(Xs)
            ridge_resid_std = float(np.std(ridge_resid))

            row = _last_usable_row(panel, feature_cols).copy()
            preds = []
            for _ in range(horizon):
                xrow = row[feature_cols].values.reshape(1, -1)
                xs = scaler.transform(xrow)
                yhat = float(ridge.predict(xs)[0])
                preds.append(yhat)
                row = _roll_cpi_lags(row, yhat)
            ridge_mean = np.array(preds)
        except Exception:
            ridge_mean = None

        # ---- XGBoost ----
        xgb_mean = None
        xgb_resid_std = 0.0
        try:
            import xgboost as xgb

            model = xgb.XGBRegressor(
                n_estimators=500,
                max_depth=3,
                learning_rate=0.025,
                subsample=0.85,
                colsample_bytree=0.80,
                reg_lambda=1.5,
                reg_alpha=0.1,
                min_child_weight=2,
                random_state=42,
                n_jobs=2,
                verbosity=0,
            )
            model.fit(X.values, y.values)
            xgb_resid = y.values - model.predict(X.values)
            xgb_resid_std = float(np.std(xgb_resid))

            row = _last_usable_row(panel, feature_cols).copy()
            preds = []
            for _ in range(horizon):
                xrow = row[feature_cols].values.reshape(1, -1)
                yhat = float(model.predict(xrow)[0])
                preds.append(yhat)
                row = _roll_cpi_lags(row, yhat)
            xgb_mean = np.array(preds)
        except Exception:
            xgb_mean = None

        # ---- Combine: inverse-RMSE if both available, else use what we have ----
        means: list[np.ndarray] = []
        weights: list[float] = []
        std_blend = 0.0
        if ridge_mean is not None:
            means.append(ridge_mean)
            # Tiny epsilon to avoid div-by-zero
            w = 1.0 / max(ridge_resid_std, 1e-6)
            weights.append(w)
        if xgb_mean is not None:
            means.append(xgb_mean)
            w = 1.0 / max(xgb_resid_std, 1e-6)
            weights.append(w)

        if not means:
            raise RuntimeError("Both Ridge and XGBoost failed.")

        wsum = sum(weights)
        norm_weights = [w / wsum for w in weights]
        mean = np.zeros(horizon, dtype=float)
        for m, w in zip(means, norm_weights):
            mean = mean + w * m

        # Blended residual std (weighted) for interval width
        for s, w in zip([ridge_resid_std, xgb_resid_std][: len(means)], norm_weights):
            std_blend += w * s
        if std_blend <= 0:
            std_blend = 0.20  # sane default for monthly CPI MoM std

        # 80% interval; spread compounds with horizon (errors accumulate recursively)
        z = 1.2816
        spread = z * std_blend * np.sqrt(np.arange(1, horizon + 1))
        lo = mean - spread
        hi = mean + spread
        return mean, lo, hi
