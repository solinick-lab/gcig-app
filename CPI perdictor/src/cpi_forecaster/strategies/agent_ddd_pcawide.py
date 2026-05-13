"""Agent DDD — PCA factor model on the WIDE panel + Ridge/XGB (round 5).

Difference vs. agent_k_factor (which scored 0.343 with 14 series and 3
components): we now have a ~37-series panel, so we extract 7 PCA factors
instead of 3. The hypothesis is that the previous PCA was undersized —
3 components on 14 series captures the broad macro story (energy,
demand, financial conditions), but the wider panel almost certainly
hosts more orthogonal signal: shelter / wages / inflation expectations
should be their own factors.

Pipeline per cut:
    raw wide panel
        |-- per-series stationary transform: YoY% for sticky/slow series,
        |   MoM% for everything else, level pass-through for rates/yields
        |-- drop columns with too few non-NaN rows
        |-- StandardScaler.fit on training rows
        |-- PCA(n_components=7).fit on training rows
        |-- factor scores F1..F7
        |-- join with CPI MoM lags 1, 2, 3, 12, 24
        |-- + month_sin / month_cos calendar features
    => Ridge (RidgeCV with TimeSeriesSplit) and XGBRegressor
       direct multi-step (one model per horizon)
    => 50/50 ensemble blend
    => 80% bands from training-residual std with sqrt(h) widening
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import TARGET


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816
_N_COMPONENTS = 7
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36
_MIN_NONNAN_FOR_SERIES = 36

# Series for which a YoY transform is more sensible than MoM.
_YOY_SERIES = {
    "CUSR0000SAH1",       # CPI Shelter — sticky, seasonal
    "CSUSHPISA",          # Case-Shiller — annual SA quirks
    "CES0500000003",      # Avg Hourly Earnings
    "M2SL",               # M2 broad money
    "CUSR0000SEHA",       # Rent of primary residence
    "CUSR0000SEHC",       # Owners' equiv rent
    "CUSR0000SAM",        # Medical care
    "CUSR0000SAS",        # Services
    "CUSR0000SAE",        # Education and communication
    "CUSR0000SAF1",       # Food
    "PCEPI",              # PCE price index
    "PCEPILFE",           # Core PCE
    "ECIWAG",             # Employment cost index — wages
}

# Series that are already rates / yields / expectations — pass level.
_LEVEL_SERIES = {
    "UNRATE",     # Unemployment rate
    "DGS10",      # 10Y Treasury yield
    "DGS2",       # 2Y Treasury yield
    "DGS5",       # 5Y Treasury yield
    "MICH",       # 1Y inflation expectations (UMich)
    "T5YIE",      # 5Y breakeven
    "T10YIE",     # 10Y breakeven
    "FEDFUNDS",   # Fed funds rate
    "DFF",        # Daily fed funds
    "TB3MS",      # 3M Tbill
    "T10Y2Y",     # 10Y - 2Y spread
    "BAMLH0A0HYM2",  # HY OAS
    "BAA10Y",     # BAA - 10Y spread
    "VIXCLS",     # VIX
    "UMCSENT",    # U Mich consumer sentiment
}


# ----------------------------- helpers ---------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _transform_series(series_id: str, col: pd.Series) -> pd.Series:
    """Pick the right stationary transform per series."""
    if series_id in _LEVEL_SERIES:
        return col.astype(float)
    if series_id in _YOY_SERIES:
        return _yoy(col)
    return _mom(col)


def _build_macro_matrix(panel: pd.DataFrame) -> pd.DataFrame:
    """Apply per-series transform to ALL non-CPI columns in the wide panel."""
    cpi_id = TARGET.fred_id
    cols: dict[str, pd.Series] = {}
    for col_name in panel.columns:
        if col_name == cpi_id:
            continue
        col = panel[col_name]
        if col.dropna().shape[0] < _MIN_NONNAN_FOR_SERIES:
            continue
        transformed = _transform_series(col_name, col)
        # Drop if transform yields all-NaN.
        if transformed.dropna().shape[0] < _MIN_NONNAN_FOR_SERIES:
            continue
        cols[col_name] = transformed
    if not cols:
        return pd.DataFrame(index=panel.index)
    macro = pd.concat(cols, axis=1)
    macro = macro.replace([np.inf, -np.inf], np.nan)
    return macro


def _build_cpi_lags(panel: pd.DataFrame) -> tuple[pd.Series, pd.DataFrame]:
    """Return (cpi_mom, lag_frame) where lag_frame has lags 1, 2, 3, 12, 24."""
    cpi = panel[TARGET.fred_id]
    cpi_mom = _log_mom(cpi).rename("cpi_mom")
    lags = pd.DataFrame(
        {
            "cpi_mom_lag1": cpi_mom.shift(1),
            "cpi_mom_lag2": cpi_mom.shift(2),
            "cpi_mom_lag3": cpi_mom.shift(3),
            "cpi_mom_lag12": cpi_mom.shift(12),
            "cpi_mom_lag24": cpi_mom.shift(24),
        },
        index=cpi.index,
    )
    return cpi_mom, lags


def _calendar_features(idx: pd.Index) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "month_sin": np.sin(2 * np.pi * idx.month / 12.0),
            "month_cos": np.cos(2 * np.pi * idx.month / 12.0),
        },
        index=idx,
    )


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
        n_estimators=400,
        max_depth=3,
        learning_rate=0.04,
        subsample=0.85,
        colsample_bytree=0.80,
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


class PcaWideStrategy(ForecastStrategy):
    """PCA(7) on the wide panel + Ridge/XGB direct multi-step ensemble."""

    name = "agent_ddd_pcawide"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ---------- main path ----------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        from sklearn.decomposition import PCA
        from sklearn.preprocessing import StandardScaler

        macro = _build_macro_matrix(panel)
        if macro.empty or macro.shape[1] == 0:
            return self._naive(panel, horizon)

        cpi_mom, cpi_lags = _build_cpi_lags(panel)
        cal = _calendar_features(panel.index)
        target = cpi_mom.rename("y_mom_pct")

        macro_cols = list(macro.columns)
        lag_cols = list(cpi_lags.columns)
        cal_cols = list(cal.columns)

        # Build the supervised frame on the union of macro + lags + cal + target.
        full = (
            macro.join(cpi_lags, how="outer")
            .join(cal, how="outer")
            .join(target, how="outer")
        )
        train_df = full.dropna(subset=macro_cols + lag_cols + ["y_mom_pct"])
        if len(train_df) < _MIN_TRAIN_ROWS:
            return self._naive(panel, horizon)

        X_macro_train = train_df[macro_cols].values.astype(float)
        X_lags_train = train_df[lag_cols].values.astype(float)
        X_cal_train = train_df[cal_cols].values.astype(float)
        y_train_h1 = train_df["y_mom_pct"].values.astype(float)

        # ---- PCA on standardized macro ----
        macro_scaler = StandardScaler().fit(X_macro_train)
        Z_train = macro_scaler.transform(X_macro_train)
        n_comp = min(_N_COMPONENTS, X_macro_train.shape[1], max(1, len(train_df) - 1))
        pca = PCA(n_components=n_comp, random_state=0).fit(Z_train)
        F_train = pca.transform(Z_train)  # (n, n_comp)

        # ---- Live macro / factor scores ----
        macro_live_df = macro.ffill(limit=3).dropna(how="any")
        if macro_live_df.empty:
            return self._naive(panel, horizon)
        macro_live = macro_live_df.iloc[-1].values.astype(float).reshape(1, -1)
        Z_live = macro_scaler.transform(macro_live)
        F_live = pca.transform(Z_live).flatten()  # (n_comp,)

        # ---- CPI lag state for live recursion-style forecasting ----
        cpi_mom_clean = cpi_mom.dropna()
        if len(cpi_mom_clean) < 24:
            return self._naive(panel, horizon)
        recent = list(cpi_mom_clean.tail(24).values.astype(float))

        # ---- Direct multi-step training: one Ridge + one XGB per horizon ----
        # For each horizon h, target is y at T+(h-1) using features at T.
        # Note: build_target/cpi_mom is MoM at T, which equals y_{T+1} for the
        # supervised setup where row-T features predict row-T value (since we
        # already aligned macro to row T, with macro using info from T).
        # To make h=1 the "next reported month from cut", we shift y by -(h-1).
        # That keeps h=1 as the standard alignment.

        # Build shared training feature matrix at level of train_df rows
        # (factors + lag block + calendar). For horizon h we shift y.
        df_train_y = train_df["y_mom_pct"]

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        # Prepare a single concatenated training X (factors + lags + cal).
        X_train_base = np.concatenate(
            [F_train, X_lags_train, X_cal_train], axis=1
        )

        for i, h in enumerate(range(1, horizon + 1)):
            # Direct multi-step: shift y by -(h-1) so h=1 is unshifted.
            if h == 1:
                y_h = df_train_y.copy()
            else:
                y_h = df_train_y.shift(-(h - 1))

            mask = ~np.isnan(y_h.values)
            if mask.sum() < _MIN_TRAIN_ROWS:
                # Not enough rows for this horizon — fall back per-step.
                yhat = _last_observed_mom(panel)
                spread = _Z80 * max(_empirical_mom_std(panel), _RESID_FLOOR) * float(np.sqrt(h))
                yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
                means[i] = yhat
                los[i] = yhat - spread
                his[i] = yhat + spread
                continue

            X_h = X_train_base[mask]
            y_h_arr = y_h.values[mask].astype(float)

            # Live x for horizon h: factors + rolled CPI lags + calendar at
            # the live index advanced by h months (sin/cos depend on month).
            lag1 = recent[-1]
            lag2 = recent[-2] if len(recent) >= 2 else lag1
            lag3 = recent[-3] if len(recent) >= 3 else lag1
            lag12 = recent[-12] if len(recent) >= 12 else lag1
            lag24 = recent[-24] if len(recent) >= 24 else lag1

            # Calendar at the forecast month: panel last index + h months.
            try:
                last_dt = panel.index[-1]
                fc_month = (last_dt + pd.DateOffset(months=h)).month
            except Exception:
                fc_month = (panel.index[-1].month + h - 1) % 12 + 1
            cal_live = np.array(
                [
                    np.sin(2 * np.pi * fc_month / 12.0),
                    np.cos(2 * np.pi * fc_month / 12.0),
                ],
                dtype=float,
            )

            x_live = np.concatenate(
                [F_live, np.array([lag1, lag2, lag3, lag12, lag24]), cal_live]
            ).reshape(1, -1)

            # ---- Ridge ----
            ridge_pred = float("nan")
            ridge_train_pred = None
            try:
                from sklearn.linear_model import RidgeCV
                from sklearn.model_selection import TimeSeriesSplit
                from sklearn.preprocessing import StandardScaler as _SS

                feat_scaler = _SS().fit(X_h)
                Xs_h = feat_scaler.transform(X_h)
                xs_live = feat_scaler.transform(x_live)
                n_splits = min(4, max(2, X_h.shape[0] // 60))
                try:
                    ridge = RidgeCV(
                        alphas=_ridge_alphas(),
                        cv=TimeSeriesSplit(n_splits=n_splits),
                    ).fit(Xs_h, y_h_arr)
                except Exception:
                    ridge = RidgeCV(alphas=_ridge_alphas()).fit(Xs_h, y_h_arr)
                ridge_pred = float(ridge.predict(xs_live)[0])
                ridge_train_pred = ridge.predict(Xs_h)
            except Exception:
                ridge_pred = float("nan")
                ridge_train_pred = None

            # ---- XGB ----
            xgb_pred = float("nan")
            xgb_train_pred = None
            try:
                from xgboost import XGBRegressor

                xgb = XGBRegressor(**_xgb_params()).fit(X_h, y_h_arr)
                xgb_pred = float(xgb.predict(x_live)[0])
                xgb_train_pred = xgb.predict(X_h)
            except Exception:
                xgb_pred = float("nan")
                xgb_train_pred = None

            # 50/50 blend, with graceful fallback if either failed.
            members: list[tuple[float, float, np.ndarray]] = []
            if np.isfinite(ridge_pred) and ridge_train_pred is not None:
                members.append((0.5, ridge_pred, ridge_train_pred))
            if np.isfinite(xgb_pred) and xgb_train_pred is not None:
                members.append((0.5, xgb_pred, xgb_train_pred))

            if not members:
                yhat = _last_observed_mom(panel)
                resid_std = max(_empirical_mom_std(panel), _RESID_FLOOR)
            else:
                wsum = sum(w for w, _, _ in members)
                members = [(w / wsum, p, tp) for w, p, tp in members]
                yhat = float(sum(w * p for w, p, _ in members))
                tp_blend = np.zeros_like(y_h_arr, dtype=float)
                for w, _, tp in members:
                    tp_blend = tp_blend + w * tp
                resid = y_h_arr - tp_blend
                resid_std = float(np.std(resid)) if len(resid) > 1 else 0.25
                if not np.isfinite(resid_std) or resid_std <= 0:
                    resid_std = 0.25
                resid_std = max(resid_std, _RESID_FLOOR)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * resid_std * float(np.sqrt(h))
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

            # Roll the CPI lag window forward with the new forecast.
            recent.append(yhat)
            if len(recent) > 36:
                recent = recent[-36:]

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
