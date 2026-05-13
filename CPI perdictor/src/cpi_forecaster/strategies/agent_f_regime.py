"""Agent F — Regime-aware forecasting.

The baseline lags at regime shifts (mid-2024 disinflation, 2025 re-acceleration)
because it averages over 20+ years of mostly-different inflation regimes. This
strategy fixes that with two levers:

1) EXPONENTIAL SAMPLE WEIGHTING: recent observations get exponentially higher
   weight in training. This is the cleanest, most robust trick for time series
   with regime drift — the model still sees all history but the loss is
   dominated by recent regime, so coefficients adapt as the regime evolves.

2) REGIME FEATURES (categorical / continuous): we engineer regime descriptors
   (acceleration, volatility, diffusion across macro inputs) and append them
   to the feature matrix. The model can then learn regime-conditional
   responses without us hard-splitting the dataset (which on ~200 rows would
   leave each regime data-starved).

We blend a sample-weighted Ridge with a sample-weighted XGBoost. Both train
on the same regime-augmented feature matrix and use the same recursive
multi-step prediction loop. 80% intervals come from in-sample residuals,
weighted by the same exponential decay so the band reflects the regime that
matters now.

Hard rule: this MUST NOT raise. Anything goes wrong, we fall back to a
last-MoM persistence forecast.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_supervised, build_target
from ..fred import FEATURES, TARGET


# Exponential decay applied to monthly observations. decay=0.015 means an
# observation 100 months back has weight ~exp(-1.5) ≈ 0.22, and 200 months
# back ~exp(-3) ≈ 0.05. Recent year (~12 months) is ~exp(-0.18) ≈ 0.84 — so
# the model still cares about the last ~5 years a lot, but the COVID/2008
# shocks are de-emphasized rather than dominating.
DECAY = 0.015


def _regime_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Engineer regime-descriptor columns aligned to panel.index.

    All values are LAGGED by 1 so they are point-in-time safe — at month T
    we only know last month's regime state.
    """
    cpi = panel[TARGET.fred_id]
    mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0  # MoM log-%

    # 6m vs 12m mean of MoM CPI: positive → accelerating, negative → decelerating.
    mom_6m = mom.rolling(6, min_periods=3).mean()
    mom_12m = mom.rolling(12, min_periods=6).mean()
    accel = (mom_6m - mom_12m).rename("regime_accel")

    # Volatility regime: rolling 6m std of MoM CPI vs its long-run median.
    vol_6m = mom.rolling(6, min_periods=3).std()
    vol_long = mom.rolling(60, min_periods=24).median()
    vol_dev = (vol_6m - vol_long).rename("regime_vol_dev")

    # Diffusion index: across the macro inputs, fraction whose YoY % change is
    # accelerating (current YoY > 6m-prior YoY). >0.5 = broad-based pressure.
    diffs: list[pd.Series] = []
    for f in FEATURES:
        col = panel[f.fred_id]
        yoy = (col / col.shift(12) - 1.0) * 100.0
        diffs.append((yoy > yoy.shift(6)).astype(float))
    if diffs:
        diffusion = pd.concat(diffs, axis=1).mean(axis=1).rename("regime_diffusion")
    else:
        diffusion = pd.Series(0.5, index=panel.index, name="regime_diffusion")

    # Categorical regime label encoded as two indicators (accelerating /
    # decelerating; steady is the implicit baseline). Threshold ~0.05 pp/mo
    # — anything tinier is statistical noise on monthly CPI.
    accel_flag = (accel > 0.05).astype(float).rename("regime_is_accel")
    decel_flag = (accel < -0.05).astype(float).rename("regime_is_decel")

    out = pd.concat(
        [accel, vol_dev, diffusion, accel_flag, decel_flag], axis=1
    )
    # All regime features are point-in-time states "as of" that month — lag
    # them by 1 so they reflect what was knowable at the time of prediction.
    out = out.shift(1)
    return out


def _exp_weights(index: pd.DatetimeIndex, decay: float) -> np.ndarray:
    """exp(-decay * months_back). Most recent obs has weight 1.0."""
    if len(index) == 0:
        return np.array([])
    # Use ordinal position rather than calendar months so weights are
    # robust to ragged/holiday gaps.
    n = len(index)
    months_back = np.arange(n - 1, -1, -1, dtype=float)
    w = np.exp(-decay * months_back)
    # Normalize to mean 1 so the effective sample size is preserved
    # (sklearn / xgboost don't require it but it stabilizes alpha tuning).
    w = w * (n / w.sum())
    return w


def _last_feature_row(feats: pd.DataFrame) -> pd.Series:
    f = feats.copy().ffill(limit=2).dropna(how="any")
    if f.empty:
        raise RuntimeError("No usable feature row.")
    return f.iloc[-1]


def _persistence_forecast(panel: pd.DataFrame, horizon: int):
    """Last observed MoM repeated. Final fallback if everything else fails."""
    try:
        last = float(build_target(panel).dropna().iloc[-1])
    except Exception:
        last = 0.20  # ~2.4% annualized, a sane prior
    m = np.array([last] * horizon)
    return m, m - 0.30, m + 0.30


class RegimeAwareStrategy(ForecastStrategy):
    name = "agent_f_regime"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._run(panel, horizon)
        except Exception:
            return _persistence_forecast(panel, horizon)

    # ------------------------------------------------------------------
    def _run(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # 1) Build the standard supervised matrix, then bolt on regime cols.
        X_base, y = build_supervised(panel)
        regime = _regime_features(panel)
        X = X_base.join(regime, how="left")
        # If any new regime columns are NaN at the head of the series, drop
        # those rows; the base build_supervised already dropped feature NaNs
        # but our regime features need extra warm-up.
        joined = X.join(y.rename("__y"), how="inner").dropna()
        if len(joined) < 36:
            return _persistence_forecast(panel, horizon)
        y_train = joined["__y"]
        X_train = joined.drop(columns=["__y"])
        feature_cols = list(X_train.columns)

        # 2) Exponential sample weights — most recent obs ≈ 1, far past ≈ 0.
        weights = _exp_weights(y_train.index, DECAY)

        # 3) Fit Ridge with weights. We use a small fixed alpha grid and pick
        #    the one minimizing weighted in-sample MSE (RidgeCV doesn't
        #    accept sample_weight cleanly across versions).
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        scaler = StandardScaler().fit(X_train.values)
        Xs = scaler.transform(X_train.values)

        best_ridge = None
        best_loss = np.inf
        for alpha in (0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0):
            try:
                m = Ridge(alpha=alpha).fit(Xs, y_train.values, sample_weight=weights)
                pred = m.predict(Xs)
                loss = float(np.average((y_train.values - pred) ** 2, weights=weights))
                if loss < best_loss:
                    best_loss = loss
                    best_ridge = m
            except Exception:
                continue
        if best_ridge is None:
            return _persistence_forecast(panel, horizon)

        ridge_resid = y_train.values - best_ridge.predict(Xs)

        # 4) Fit XGBoost with the same sample weights. Conservative settings
        #    matching the base XgbForecaster — this is a small dataset.
        xgb_model = None
        xgb_resid = None
        try:
            import xgboost as xgb

            xgb_model = xgb.XGBRegressor(
                n_estimators=350,
                max_depth=3,
                learning_rate=0.03,
                subsample=0.85,
                colsample_bytree=0.85,
                reg_lambda=1.0,
                random_state=42,
                n_jobs=2,
                verbosity=0,
            )
            xgb_model.fit(X_train.values, y_train.values, sample_weight=weights)
            xgb_pred = xgb_model.predict(X_train.values)
            xgb_resid = y_train.values - xgb_pred
        except Exception:
            xgb_model = None

        # 5) Build the rolling forecast row. We need the regime cols on the
        #    LIVE panel (not just the training join), so re-derive them.
        live_feats = build_features(panel).join(_regime_features(panel), how="left")
        feat_row = _last_feature_row(live_feats)

        means: list[float] = []
        for _ in range(horizon):
            # Make sure all expected columns exist; missing → 0 (mean-impute
            # on standardized space is a 0).
            row_vals = np.array(
                [float(feat_row.get(c, 0.0)) for c in feature_cols]
            ).reshape(1, -1)
            # Ridge prediction in scaled space.
            ridge_yhat = float(best_ridge.predict(scaler.transform(row_vals))[0])
            # XGB prediction in raw space.
            if xgb_model is not None:
                try:
                    xgb_yhat = float(xgb_model.predict(row_vals)[0])
                    yhat = 0.5 * ridge_yhat + 0.5 * xgb_yhat
                except Exception:
                    yhat = ridge_yhat
            else:
                yhat = ridge_yhat
            means.append(yhat)

            # Roll CPI lags forward; macro features and regime descriptors
            # are held flat (the regime is by construction slow-moving, so
            # this is a defensible short-horizon assumption).
            feat_row["cpi_mom_lag3"] = feat_row.get("cpi_mom_lag2", yhat)
            feat_row["cpi_mom_lag2"] = feat_row.get("cpi_mom_lag1", yhat)
            feat_row["cpi_mom_lag1"] = yhat

        means_arr = np.array(means)

        # 6) Weighted residual std → 80% bands, scaled by sqrt(h) for the
        #    recursive multi-step error compounding.
        if xgb_resid is not None:
            blended_resid = 0.5 * ridge_resid + 0.5 * xgb_resid
        else:
            blended_resid = ridge_resid
        resid_var = float(np.average(blended_resid ** 2, weights=weights))
        resid_std = float(np.sqrt(max(resid_var, 1e-8)))
        z = 1.2816  # 80% one-sided
        spread = z * resid_std * np.sqrt(np.arange(1, horizon + 1))
        return means_arr, means_arr - spread, means_arr + spread
