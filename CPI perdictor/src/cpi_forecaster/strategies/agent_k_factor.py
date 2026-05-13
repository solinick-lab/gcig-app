"""Agent K: PCA factor model (Stock-Watson approach).

Extracts a small number of latent factors from the 14 macro feature
series via PCA, then uses those factor scores plus a few CPI lags as
inputs to a Ridge + XGBoost ensemble.

Idea: the macro panel shares underlying economic factors; PCA denoises
and concentrates the signal into a compact, low-noise feature matrix.
With ~14 standardized series, n_components=3 captures the dominant
common variation (energy, demand, financial conditions roughly).

Pipeline per cut:
    raw panel
        |-- per-series stationary transform (MoM% or YoY%)
        |   to build a clean macro feature matrix
        |-- StandardScaler.fit on training rows
        |-- PCA(n_components=3).fit on training rows
        |-- factor scores F1..F3
        |-- join with CPI MoM lags 1, 2, 3, 12
    => Ridge + XGBoost, 50/50 ensemble
    => recursive multi-step (roll CPI lags forward; hold factors flat)
    => 80% intervals from training residual std * sqrt(h) * z=1.2816
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import FEATURES, TARGET


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816
_N_COMPONENTS = 3
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10

# Series for which a YoY transform is more sensible than MoM (slow-moving,
# heavy seasonality, or level-y variables where the change-on-change is
# noisy). Everything else goes to MoM%.
_YOY_SERIES = {
    "CUSR0000SAH1",   # CPI Shelter — sticky, seasonal
    "CSUSHPISA",      # Case-Shiller home prices — annual SA quirks
    "CES0500000003",  # Avg Hourly Earnings — wage growth read better YoY
    "M2SL",           # M2 — broad monetary stock; YoY is the standard view
}

# Series that are already rates / yields / expectations — no need to
# transform, they're stationary-ish. We still standardize.
_LEVEL_SERIES = {
    "UNRATE",   # Unemployment rate
    "DGS10",    # 10Y Treasury yield
    "MICH",     # 1Y inflation expectations
}


# ----------------------------- helpers ---------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _transform_feature(series_id: str, col: pd.Series) -> pd.Series:
    """Pick the right stationary transform per series."""
    if series_id in _LEVEL_SERIES:
        # Already stationary-ish; pass level through.
        return col.astype(float)
    if series_id in _YOY_SERIES:
        return _yoy(col)
    return _mom(col)


def _build_macro_matrix(panel: pd.DataFrame) -> pd.DataFrame:
    """Apply per-series transform to the 14 macro features and stack as wide DF."""
    cols: dict[str, pd.Series] = {}
    for f in FEATURES:
        if f.fred_id not in panel.columns:
            continue
        cols[f.fred_id] = _transform_feature(f.fred_id, panel[f.fred_id])
    macro = pd.concat(cols, axis=1)
    macro = macro.replace([np.inf, -np.inf], np.nan)
    return macro


def _build_cpi_lags(panel: pd.DataFrame) -> tuple[pd.Series, pd.DataFrame]:
    """Return (cpi_mom, lag_frame) where lag_frame has lag-1/2/3/12."""
    cpi = panel[TARGET.fred_id]
    cpi_mom = _log_mom(cpi).rename("cpi_mom")
    lags = pd.DataFrame(
        {
            "cpi_mom_lag1": cpi_mom.shift(1),
            "cpi_mom_lag2": cpi_mom.shift(2),
            "cpi_mom_lag3": cpi_mom.shift(3),
            "cpi_mom_lag12": cpi_mom.shift(12),
        },
        index=cpi.index,
    )
    return cpi_mom, lags


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


# --------------------------- the strategy -----------------------------


class FactorModelStrategy(ForecastStrategy):
    """Stock-Watson style PCA factor model + Ridge/XGB ensemble."""

    name = "agent_k_factor"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---------- main path: PCA factors + ensemble + recursive multi-step ----

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.decomposition import PCA
        from sklearn.model_selection import TimeSeriesSplit

        macro = _build_macro_matrix(panel)
        cpi_mom, cpi_lags = _build_cpi_lags(panel)
        target = cpi_mom.rename("y_mom_pct")

        # Build the supervised frame on the union of macro + lags + target.
        full = macro.join(cpi_lags, how="outer").join(target, how="outer")
        # Macro rows usable iff macro features are all present.
        macro_cols = list(macro.columns)
        lag_cols = list(cpi_lags.columns)

        # Training rows: need all macro + all lags + target.
        train_df = full.dropna(subset=macro_cols + lag_cols + ["y_mom_pct"])
        if len(train_df) < 36:
            return self._naive(panel, horizon)

        X_macro_train = train_df[macro_cols].values.astype(float)
        X_lags_train = train_df[lag_cols].values.astype(float)
        y_train = train_df["y_mom_pct"].values.astype(float)

        # ---- PCA on standardized macro ----
        scaler = StandardScaler().fit(X_macro_train)
        Z_train = scaler.transform(X_macro_train)
        n_comp = min(_N_COMPONENTS, X_macro_train.shape[1], max(1, len(train_df) - 1))
        pca = PCA(n_components=n_comp, random_state=0).fit(Z_train)
        F_train = pca.transform(Z_train)

        # Final feature matrix: factors + CPI lags.
        X_train = np.concatenate([F_train, X_lags_train], axis=1)

        # ---- Ridge ----
        feat_scaler = StandardScaler().fit(X_train)
        Xs_train = feat_scaler.transform(X_train)
        n_splits = min(4, max(2, len(train_df) // 60))
        try:
            ridge = RidgeCV(
                alphas=_ridge_alphas(),
                cv=TimeSeriesSplit(n_splits=n_splits),
            ).fit(Xs_train, y_train)
        except Exception:
            ridge = RidgeCV(alphas=_ridge_alphas()).fit(Xs_train, y_train)

        # ---- XGB ----
        xgb_model = None
        try:
            from xgboost import XGBRegressor
            xgb_model = XGBRegressor(**_xgb_params()).fit(X_train, y_train)
        except Exception:
            xgb_model = None

        # ---- Training residuals for interval width ----
        ridge_in = ridge.predict(Xs_train)
        if xgb_model is not None:
            xgb_in = xgb_model.predict(X_train)
            blend_in = 0.5 * ridge_in + 0.5 * xgb_in
        else:
            blend_in = ridge_in
        resid = y_train - blend_in
        resid_std = float(np.std(resid))
        if not np.isfinite(resid_std) or resid_std <= 0:
            resid_std = 0.20
        resid_std = max(resid_std, _RESID_FLOOR)

        # ---- Live factor scores ----
        # Use the most recent macro row available (forward-fill tiny gaps).
        macro_live_df = macro.ffill(limit=3).dropna(how="any")
        if macro_live_df.empty:
            return self._naive(panel, horizon)
        macro_live = macro_live_df.iloc[-1].values.astype(float).reshape(1, -1)
        Z_live = scaler.transform(macro_live)
        F_live = pca.transform(Z_live).flatten()  # shape (n_comp,)

        # ---- Live CPI lag state (rolled forward in the recursion) ----
        cpi_mom_clean = cpi_mom.dropna()
        if len(cpi_mom_clean) < 12:
            return self._naive(panel, horizon)
        # lag_state[k] = CPI MoM at horizon-relative lag k (1-indexed).
        # We need lags 1, 2, 3, 12 over the recursion. Track a deque-style list
        # of the most recent 12 observed/forecast MoMs.
        recent = list(cpi_mom_clean.tail(12).values.astype(float))
        # recent[-1] is most-recent observed; index from the end:
        # lag1 = recent[-1], lag2 = recent[-2], ..., lag12 = recent[-12].

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            lag1 = recent[-1]
            lag2 = recent[-2] if len(recent) >= 2 else lag1
            lag3 = recent[-3] if len(recent) >= 3 else lag1
            lag12 = recent[-12] if len(recent) >= 12 else lag1

            # Factors held flat at last-known values (factors are smooth).
            x_live = np.concatenate([F_live, np.array([lag1, lag2, lag3, lag12])])
            x_live = x_live.reshape(1, -1)

            ridge_pred = float(ridge.predict(feat_scaler.transform(x_live))[0])
            if xgb_model is not None:
                xgb_pred = float(xgb_model.predict(x_live)[0])
                yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            else:
                yhat = ridge_pred

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * resid_std * float(np.sqrt(h))
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

            # Roll the CPI lag window forward with the new forecast.
            recent.append(yhat)
            if len(recent) > 24:
                recent = recent[-24:]

        return means, los, his

    # ---------- last-resort fallback: persistence ----------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
