"""Agent D — Kitchen Sink ensemble.

Pulls together a diverse set of regressors trained on an enriched feature
matrix derived from the same 15-series panel the rest of the system uses.
The diversity comes from two angles:

  1. MORE MODELS: Ridge, ElasticNet, Lasso, GradientBoostingRegressor
     (sklearn's LightGBM stand-in), RandomForestRegressor, and XGBoost.
     Different bias/variance trade-offs ought to capture different
     pieces of the inflation story.

  2. MORE DERIVED SIGNALS: on top of build_features we tack on log-MoM
     deeper lags, a few EWMAs, simple ratios/spreads, regime flags, and
     a couple of cross-series interactions. Within-strategy only — the
     panel itself is untouched, so the rest of the race is unaffected.

Inverse-CV-error weighted ensemble (TimeSeriesSplit). Recursive multi-step
in MoM log-% space; intervals from training residual std with sqrt(h)
spread. Wraps everything in try/except: on any blow-up we fall back to
the last observed MoM repeated forward.
"""

from __future__ import annotations

import warnings
from typing import Any

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target, build_supervised
from ..fred import FEATURES, TARGET


def _safe_div(a: pd.Series, b: pd.Series) -> pd.Series:
    """Element-wise a/b that swallows divide-by-zero and infinities."""
    with np.errstate(divide="ignore", invalid="ignore"):
        out = a / b
    return out.replace([np.inf, -np.inf], np.nan)


def _ewma_pct(s: pd.Series, span: int) -> pd.Series:
    """EWMA of the % change of s. Useful smoothing for noisy series."""
    pct = (s / s.shift(1) - 1.0) * 100.0
    return pct.ewm(span=span, adjust=False, min_periods=2).mean()


def _build_kitchen_sink_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Take the standard build_features matrix and bolt on extra signals.

    We deliberately keep this conservative — too many extra columns on a
    monthly dataset just multiplies noise. Targeted derived signals only.
    """
    base = build_features(panel)

    extras: dict[str, pd.Series] = {}
    cpi = panel[TARGET.fred_id]
    log_cpi_mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0

    # Deeper CPI lags + a 6-month moving average of MoM (regime memory).
    for k in (4, 6, 9, 12):
        extras[f"cpi_mom_lag{k}"] = log_cpi_mom.shift(k)
    extras["cpi_mom_ma6_lag1"] = log_cpi_mom.rolling(6, min_periods=3).mean().shift(1)
    extras["cpi_mom_ma12_lag1"] = log_cpi_mom.rolling(12, min_periods=6).mean().shift(1)
    extras["cpi_mom_std6_lag1"] = log_cpi_mom.rolling(6, min_periods=3).std().shift(1)

    # EWMAs of every macro series' MoM. Smoother trend signal.
    for f in FEATURES:
        col = panel[f.fred_id]
        extras[f"{f.fred_id}_ewma3_lag1"] = _ewma_pct(col, span=3).shift(1)
        extras[f"{f.fred_id}_ewma6_lag1"] = _ewma_pct(col, span=6).shift(1)

    # Simple regime flags — binary indicators of "elevated" stress.
    # All built from lagged data so no leakage.
    unrate = panel.get("UNRATE")
    if unrate is not None:
        extras["unrate_above_5"] = (unrate.shift(1) > 5.0).astype(float)
        extras["unrate_delta3_lag1"] = (unrate - unrate.shift(3)).shift(1)

    oil = panel.get("DCOILWTICO")
    gas = panel.get("GASREGW")
    if oil is not None and gas is not None:
        # Energy crack-spread-ish ratio: retail gas vs WTI. Captures
        # refining margin pressure that often shows up in CPI energy.
        extras["gas_oil_ratio_lag1"] = _safe_div(gas, oil).shift(1)
        extras["oil_yoy_lag1"] = ((oil / oil.shift(12) - 1.0) * 100.0).shift(1)

    # Real wages proxy: hourly earnings YoY minus CPI YoY (lagged).
    earn = panel.get("CES0500000003")
    if earn is not None:
        wage_yoy = (earn / earn.shift(12) - 1.0) * 100.0
        cpi_yoy = (cpi / cpi.shift(12) - 1.0) * 100.0
        extras["real_wage_yoy_lag1"] = (wage_yoy - cpi_yoy).shift(1)

    # Yield curve / monetary slack proxies.
    dgs10 = panel.get("DGS10")
    if dgs10 is not None:
        extras["dgs10_delta3_lag1"] = (dgs10 - dgs10.shift(3)).shift(1)

    m2 = panel.get("M2SL")
    if m2 is not None:
        m2_yoy = (m2 / m2.shift(12) - 1.0) * 100.0
        extras["m2_yoy_lag1"] = m2_yoy.shift(1)

    # Shelter is sticky — its YoY is a slow-moving but powerful signal.
    shelter = panel.get("CUSR0000SAH1")
    if shelter is not None:
        shelter_yoy = (shelter / shelter.shift(12) - 1.0) * 100.0
        extras["shelter_yoy_lag1"] = shelter_yoy.shift(1)
        extras["shelter_yoy_delta6_lag1"] = (
            shelter_yoy - shelter_yoy.shift(6)
        ).shift(1)

    # Cross interactions: oil*USD (importer/exporter pressure),
    # earnings*shelter (services-driven inflation).
    usd = panel.get("DTWEXBGS")
    if oil is not None and usd is not None:
        oil_mom = (oil / oil.shift(1) - 1.0) * 100.0
        usd_mom = (usd / usd.shift(1) - 1.0) * 100.0
        extras["oil_x_usd_lag1"] = (oil_mom * usd_mom).shift(1)

    extras_df = pd.DataFrame(extras, index=base.index)
    out = pd.concat([base, extras_df], axis=1)
    # Replace inf with NaN so the dropna in build_supervised-equivalent works.
    return out.replace([np.inf, -np.inf], np.nan)


def _build_supervised_kitchen(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    y = build_target(panel)
    X = _build_kitchen_sink_features(panel)
    df = X.join(y, how="inner").dropna()
    return df.drop(columns=["y_mom_pct"]), df["y_mom_pct"]


def _make_models() -> list[tuple[str, Any, bool]]:
    """Construct the model zoo. Tuple is (name, estimator, needs_scaling).

    Linear models get StandardScaler; trees don't need it. Each model
    is given conservative hyperparameters — we want quick per-cut runs
    in the race, not exhaustive tuning.
    """
    from sklearn.linear_model import RidgeCV, ElasticNetCV, LassoCV
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor

    models: list[tuple[str, Any, bool]] = []

    # Linear family — three regularization styles.
    models.append(
        (
            "ridge",
            RidgeCV(alphas=np.logspace(-3, 3, 21)),
            True,
        )
    )
    models.append(
        (
            "elasticnet",
            ElasticNetCV(
                l1_ratio=[0.1, 0.3, 0.5, 0.7, 0.9],
                alphas=np.logspace(-4, 1, 25),
                cv=5,
                max_iter=5000,
                random_state=0,
            ),
            True,
        )
    )
    models.append(
        (
            "lasso",
            LassoCV(
                alphas=np.logspace(-4, 1, 25),
                cv=5,
                max_iter=5000,
                random_state=0,
            ),
            True,
        )
    )

    # Tree family — three flavors.
    models.append(
        (
            "gbr",
            GradientBoostingRegressor(
                n_estimators=300,
                max_depth=3,
                learning_rate=0.05,
                subsample=0.8,
                random_state=0,
            ),
            False,
        )
    )
    models.append(
        (
            "rf",
            RandomForestRegressor(
                n_estimators=300,
                max_depth=6,
                min_samples_leaf=2,
                n_jobs=1,
                random_state=0,
            ),
            False,
        )
    )

    # XGBoost — different gradient-boosting flavor than GBR.
    try:
        from xgboost import XGBRegressor

        models.append(
            (
                "xgb",
                XGBRegressor(
                    n_estimators=400,
                    max_depth=4,
                    learning_rate=0.05,
                    subsample=0.85,
                    colsample_bytree=0.85,
                    reg_lambda=1.0,
                    objective="reg:squarederror",
                    random_state=0,
                    n_jobs=1,
                    verbosity=0,
                ),
                False,
            )
        )
    except Exception:
        # XGBoost not importable for some reason — skip it. The other
        # five models still give us a healthy ensemble.
        pass

    return models


def _cv_weights(
    X: np.ndarray, y: np.ndarray, models: list[tuple[str, Any, bool]]
) -> dict[str, float]:
    """Inverse-RMSE weights from a TimeSeriesSplit. Falls back to equal
    weights if CV fails for any reason (e.g. tiny training set)."""
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.preprocessing import StandardScaler
    from sklearn.base import clone

    n = len(y)
    # Need enough rows for a meaningful split; otherwise equal weights.
    if n < 60:
        return {name: 1.0 / len(models) for name, _, _ in models}

    n_splits = min(5, max(2, n // 30))
    try:
        tscv = TimeSeriesSplit(n_splits=n_splits)
    except Exception:
        return {name: 1.0 / len(models) for name, _, _ in models}

    rmses: dict[str, list[float]] = {name: [] for name, _, _ in models}

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for tr, te in tscv.split(X):
            Xtr, Xte = X[tr], X[te]
            ytr, yte = y[tr], y[te]
            scaler = StandardScaler().fit(Xtr)
            Xtr_s = scaler.transform(Xtr)
            Xte_s = scaler.transform(Xte)
            for name, est, needs_scale in models:
                try:
                    m = clone(est)
                    if needs_scale:
                        m.fit(Xtr_s, ytr)
                        pred = m.predict(Xte_s)
                    else:
                        m.fit(Xtr, ytr)
                        pred = m.predict(Xte)
                    err = float(np.sqrt(np.mean((yte - pred) ** 2)))
                    if np.isfinite(err):
                        rmses[name].append(err)
                except Exception:
                    # This fold blew up for this model — skip; it'll
                    # just contribute fewer samples to the average.
                    continue

    avg: dict[str, float] = {}
    for name, _, _ in models:
        vals = rmses[name]
        avg[name] = float(np.mean(vals)) if vals else float("inf")

    # Inverse-RMSE → normalize. Cap really bad models at near-zero weight.
    inv: dict[str, float] = {}
    for name, rmse in avg.items():
        if not np.isfinite(rmse) or rmse <= 0:
            inv[name] = 0.0
        else:
            inv[name] = 1.0 / rmse
    total = sum(inv.values())
    if total <= 0:
        return {name: 1.0 / len(models) for name, _, _ in models}
    return {name: w / total for name, w in inv.items()}


class KitchenSinkStrategy(ForecastStrategy):
    """Six-model inverse-CV-RMSE ensemble on engineered macro features."""

    name = "agent_d_kitchensink"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Naive fallback we use if the full pipeline blows up.
        try:
            last_mom = float(build_target(panel).dropna().iloc[-1])
        except Exception:
            last_mom = 0.2  # ~2.4% annualized; reasonable neutral guess.

        def _fallback() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
            mean = np.array([last_mom] * horizon)
            spread = 0.30 * np.sqrt(np.arange(1, horizon + 1))
            return mean, mean - spread, mean + spread

        try:
            from sklearn.preprocessing import StandardScaler
            from sklearn.base import clone

            X_df, y = _build_supervised_kitchen(panel)
            if len(y) < 36 or X_df.shape[1] == 0:
                return _fallback()

            X = X_df.values.astype(float)
            y_arr = y.values.astype(float)
            feature_cols = list(X_df.columns)

            models = _make_models()
            if not models:
                return _fallback()

            weights = _cv_weights(X, y_arr, models)

            # Final fit on the full training set for each model.
            scaler = StandardScaler().fit(X)
            X_scaled = scaler.transform(X)

            fitted: list[tuple[str, Any, bool, float]] = []
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                for name, est, needs_scale in models:
                    w = weights.get(name, 0.0)
                    if w <= 0:
                        continue
                    try:
                        m = clone(est)
                        if needs_scale:
                            m.fit(X_scaled, y_arr)
                        else:
                            m.fit(X, y_arr)
                        fitted.append((name, m, needs_scale, w))
                    except Exception:
                        # Drop this model from the ensemble; renormalize later.
                        continue

            if not fitted:
                return _fallback()

            # Renormalize weights to the models that actually fit.
            wsum = sum(w for *_, w in fitted)
            if wsum <= 0:
                return _fallback()
            fitted = [(n, m, s, w / wsum) for n, m, s, w in fitted]

            # Training residuals from the weighted ensemble — used for
            # interval width.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                ens_pred_train = np.zeros_like(y_arr)
                for name, m, needs_scale, w in fitted:
                    pred = m.predict(X_scaled if needs_scale else X)
                    ens_pred_train = ens_pred_train + w * pred
            resid = y_arr - ens_pred_train
            resid_std = float(np.std(resid)) if len(resid) > 1 else 0.30
            if not np.isfinite(resid_std) or resid_std <= 0:
                resid_std = 0.30

            # Get the latest feature row for recursive prediction.
            feats_full = _build_kitchen_sink_features(panel).copy()
            feats_full = feats_full.ffill(limit=2)
            feats_full = feats_full.dropna(how="any")
            if feats_full.empty:
                return _fallback()
            feat_row = feats_full.iloc[-1].copy()

            means: list[float] = []
            for _ in range(horizon):
                row_vec = feat_row.reindex(feature_cols).values.astype(float)
                # Defensive: any residual NaN -> 0 (shouldn't happen after ffill+dropna).
                row_vec = np.nan_to_num(row_vec, nan=0.0, posinf=0.0, neginf=0.0)
                row_vec = row_vec.reshape(1, -1)
                row_scaled = scaler.transform(row_vec)

                yhat = 0.0
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    for name, m, needs_scale, w in fitted:
                        try:
                            p = float(
                                m.predict(row_scaled if needs_scale else row_vec)[0]
                            )
                        except Exception:
                            p = last_mom
                        yhat += w * p
                if not np.isfinite(yhat):
                    yhat = last_mom
                means.append(yhat)

                # Roll the CPI lag features forward exactly like the
                # Ridge wrapper does. Other macro features stay frozen.
                if "cpi_mom_lag12" in feat_row.index:
                    feat_row["cpi_mom_lag12"] = feat_row.get("cpi_mom_lag9", 0.0)
                if "cpi_mom_lag9" in feat_row.index:
                    feat_row["cpi_mom_lag9"] = feat_row.get("cpi_mom_lag6", 0.0)
                if "cpi_mom_lag6" in feat_row.index:
                    feat_row["cpi_mom_lag6"] = feat_row.get("cpi_mom_lag4", 0.0)
                if "cpi_mom_lag4" in feat_row.index:
                    feat_row["cpi_mom_lag4"] = feat_row.get("cpi_mom_lag3", 0.0)
                if "cpi_mom_lag3" in feat_row.index:
                    feat_row["cpi_mom_lag3"] = feat_row.get("cpi_mom_lag2", 0.0)
                if "cpi_mom_lag2" in feat_row.index:
                    feat_row["cpi_mom_lag2"] = feat_row.get("cpi_mom_lag1", 0.0)
                if "cpi_mom_lag1" in feat_row.index:
                    feat_row["cpi_mom_lag1"] = yhat

            mean_arr = np.array(means, dtype=float)
            z = 1.2816  # 80% one-sided
            spread = z * resid_std * np.sqrt(np.arange(1, horizon + 1))
            return mean_arr, mean_arr - spread, mean_arr + spread

        except Exception:
            return _fallback()
