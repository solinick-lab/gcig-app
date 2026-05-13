"""Champion strategy: rich features + direct multi-step + per-horizon stacking.

Combines the three winning ideas from the horse race:

  1. Agent C's *enriched feature matrix* — PPI/CPI spread, oil/gas
     momentum * level interactions, sticky shelter MAs, wage-price
     spread, M2 growth, MICH level + change, USD passthrough, real-rate
     proxy, vol-regime dummy, calendar terms.

  2. Agent B's *direct multi-step* structure — for each horizon h we
     train SEPARATE base models on (X_T, y_{T+h}) instead of recursing.
     This avoids feeding noisy own-forecasts back into the lag features.

  3. Agent E's *learned stacking meta-learner* — instead of inverse-RMSE
     or 50/50 blending, we fit a Ridge that combines the base predictions
     into the final forecast. One meta-Ridge per horizon, trained on
     out-of-fold base predictions generated via TimeSeriesSplit.

So the per-horizon pipeline is:
    enriched X  ->  Ridge & XGB base models  ->  Ridge meta  ->  yhat_h

Defensive: fit_and_predict is wrapped in nested try/except. If stacking
fails we fall back to a 50/50 blend; if base models fail we fall back to
last-observed MoM. The race contract requires no exceptions.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import FEATURES, TARGET


# Suppress the noisy convergence / future warnings from sklearn + xgb.
warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816                 # one-sided z for 80% interval
_N_OOF_FOLDS = 3              # TimeSeriesSplit folds for OOF stacking
_MIN_TRAIN_ROWS = 60          # below this we don't bother stacking
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits


# ----------------------------- helpers ---------------------------------

def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    # Tiny floor avoids log(0) blowups on noisy series.
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _pct_change_n(s: pd.Series, n: int) -> pd.Series:
    return (s / s.shift(n) - 1.0) * 100.0


def _diff_n(s: pd.Series, n: int) -> pd.Series:
    return s - s.shift(n)


# --------------------- rich feature construction (Agent C) ----------------------

def _build_rich_features(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Build the enriched feature matrix and aligned target.

    Target: log MoM % change in CPI. Features are all lag-1+ to avoid
    leakage (everything available at end of month T-1 to predict T).
    Verbatim from Agent C — that strategy was best at h1 (RMSE 0.121).
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
    rows["cpi_mom_avg3_lag1"] = cpi_mom.rolling(3).mean().shift(1)
    rows["cpi_mom_avg6_lag1"] = cpi_mom.rolling(6).mean().shift(1)
    rows["cpi_mom_accel_lag1"] = (
        cpi_mom.rolling(3).mean() - cpi_mom.rolling(3).mean().shift(3)
    ).shift(1)

    # ---- Realized CPI volatility regime ----
    cpi_vol_12 = cpi_mom.rolling(12).std()
    rows["cpi_vol12_lag1"] = cpi_vol_12.shift(1)
    long_run_median = cpi_vol_12.expanding(min_periods=24).median()
    crisis = (cpi_vol_12 > long_run_median).astype(float)
    rows["cpi_vol_regime_lag1"] = crisis.shift(1)

    # ---- Per-series lag-1 standard transforms ----
    for f in FEATURES:
        if f.fred_id not in panel.columns:
            continue
        col = panel[f.fred_id]
        rows[f"{f.fred_id}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{f.fred_id}_3mo_lag1"] = _pct_change_n(col, 3).shift(1)
        rows[f"{f.fred_id}_yoy_lag1"] = _yoy(col).shift(1)

    # ---- PPI-CPI spread (cost passthrough) ----
    if "PPIACO" in panel.columns:
        ppi_yoy = _yoy(panel["PPIACO"])
        rows["ppi_cpi_spread_lag1"] = (ppi_yoy - cpi_yoy).shift(1)
        rows["ppi_cpi_spread_chg3_lag1"] = (
            (ppi_yoy - cpi_yoy) - (ppi_yoy - cpi_yoy).shift(3)
        ).shift(1)
    if "PPIFIS" in panel.columns:
        ppifis_yoy = _yoy(panel["PPIFIS"])
        rows["ppifis_cpi_spread_lag1"] = (ppifis_yoy - cpi_yoy).shift(1)

    # ---- Oil/gas: momentum * level (asymmetric passthrough) ----
    if "DCOILWTICO" in panel.columns:
        oil = panel["DCOILWTICO"]
        oil_mom = _mom(oil)
        oil_3mo = _pct_change_n(oil, 3)
        oil_level_z = (oil - oil.expanding(min_periods=24).mean()) / (
            oil.expanding(min_periods=24).std().replace(0, np.nan)
        )
        rows["oil_mom_x_level_lag1"] = (oil_mom * oil_level_z).shift(1)
        rows["oil_3mo_x_level_lag1"] = (oil_3mo * oil_level_z).shift(1)
        rows["oil_mom_sq_lag1"] = (oil_mom.pow(2) * np.sign(oil_mom)).shift(1)
        rows["oil_6mo_lag1"] = _pct_change_n(oil, 6).shift(1)
    if "GASREGW" in panel.columns:
        gas = panel["GASREGW"]
        gas_mom = _mom(gas)
        rows["gas_mom_sq_lag1"] = (gas_mom.pow(2) * np.sign(gas_mom)).shift(1)
        rows["gas_3mo_lag1_extra"] = _pct_change_n(gas, 3).shift(1)

    # ---- Shelter: 6-mo MA of MoM (rents are sticky) ----
    if "CUSR0000SAH1" in panel.columns:
        shelter = panel["CUSR0000SAH1"]
        shelter_mom = _mom(shelter)
        rows["shelter_mom_ma6_lag1"] = shelter_mom.rolling(6).mean().shift(1)
        rows["shelter_mom_ma12_lag1"] = shelter_mom.rolling(12).mean().shift(1)
        rows["shelter_accel_lag1"] = (
            shelter_mom.rolling(3).mean() - shelter_mom.rolling(3).mean().shift(3)
        ).shift(1)

    # ---- Home prices: passthrough into shelter is delayed ~12-18 mo ----
    if "CSUSHPISA" in panel.columns:
        hpi_yoy = _yoy(panel["CSUSHPISA"])
        rows["hpi_yoy_lag12"] = hpi_yoy.shift(12)
        rows["hpi_yoy_lag18"] = hpi_yoy.shift(18)

    # ---- Wage-price spiral ----
    if "CES0500000003" in panel.columns:
        ahe_yoy = _yoy(panel["CES0500000003"])
        rows["wage_price_spread_lag1"] = (ahe_yoy - cpi_yoy).shift(1)
        if "UNRATE" in panel.columns:
            unrate = panel["UNRATE"]
            rows["wage_x_tightness_lag1"] = (ahe_yoy * (10.0 - unrate)).shift(1)

    # ---- M2 growth (monetary impulse) ----
    if "M2SL" in panel.columns:
        m2 = panel["M2SL"]
        rows["m2_yoy_lag1"] = _yoy(m2).shift(1)
        rows["m2_3mo_lag1"] = _pct_change_n(m2, 3).shift(1)
        if "INDPRO" in panel.columns:
            indpro_yoy = _yoy(panel["INDPRO"])
            rows["m2_x_indpro_lag1"] = (_yoy(m2) * indpro_yoy).shift(1)

    # ---- Inflation expectations: level AND change ----
    if "MICH" in panel.columns:
        mich = panel["MICH"]
        rows["mich_level_lag1"] = mich.shift(1)
        rows["mich_chg3_lag1"] = _diff_n(mich, 3).shift(1)
        rows["mich_chg6_lag1"] = _diff_n(mich, 6).shift(1)
        rows["mich_vs_cpi_lag1"] = (mich - cpi_yoy).shift(1)

    # ---- USD index: import price passthrough ----
    if "DTWEXBGS" in panel.columns:
        usd = panel["DTWEXBGS"]
        rows["usd_chg6_lag1"] = _pct_change_n(usd, 6).shift(1)
        rows["usd_chg12_lag1"] = _pct_change_n(usd, 12).shift(1)
        rows["usd_chg6_lag6"] = _pct_change_n(usd, 6).shift(6)

    # ---- 10Y real-rate proxy ----
    if "DGS10" in panel.columns:
        dgs10 = panel["DGS10"]
        rows["real_rate_proxy_lag1"] = (dgs10 - cpi_yoy).shift(1)
        rows["dgs10_chg6_lag1"] = _diff_n(dgs10, 6).shift(1)

    # ---- Demand pressure ----
    if "INDPRO" in panel.columns:
        indpro = panel["INDPRO"]
        rows["indpro_3mo_lag1"] = _pct_change_n(indpro, 3).shift(1)
    if "RSAFS" in panel.columns:
        rsafs = panel["RSAFS"]
        rows["rsafs_3mo_lag1"] = _pct_change_n(rsafs, 3).shift(1)

    # ---- Unemployment slack/tightness ----
    if "UNRATE" in panel.columns:
        unrate = panel["UNRATE"]
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
    feats = feats.replace([np.inf, -np.inf], np.nan)
    return feats, target


def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    """Most recent feature row for prediction. Forward-fills tiny ragged-edge gaps."""
    feats = X_full.copy()
    feats = feats.ffill(limit=3)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


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


# ----------------------- per-horizon training helpers -------------------

def _xgb_params() -> dict:
    """Modest XGB config — small panel, want low variance."""
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


def _meta_alphas() -> np.ndarray:
    # Tiny OOF training set (~12-18 rows) — keep alpha grid small but
    # weighted toward regularisation. The meta has only 2 features
    # (ridge_pred, xgb_pred) plus intercept, so alpha=1 is reasonable.
    return np.array([0.05, 0.1, 0.3, 1.0, 3.0, 10.0])


def _fit_base_for_horizon(
    X_full: pd.DataFrame,
    y_full: pd.Series,
    h: int,
):
    """Build the (X_T, y_{T+h}) supervised pair, fit Ridge + XGB on the
    full slice, and return everything needed for OOF + final inference.

    Returns dict with: X_arr, y_arr, df_index, feature_cols, scaler,
    ridge_full, xgb_full. None on failure.
    """
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    y_target = y_full.shift(-h).rename("y_target")
    df = X_full.join(y_target, how="inner").dropna()
    if len(df) < _MIN_TRAIN_ROWS - 12:  # softer threshold per-horizon
        return None
    feature_cols = [c for c in df.columns if c != "y_target"]
    X_arr = df[feature_cols].values.astype(float)
    y_arr = df["y_target"].values.astype(float)

    scaler = StandardScaler().fit(X_arr)
    Xs = scaler.transform(X_arr)
    n_splits = min(4, max(2, len(df) // 60))
    try:
        ridge_full = RidgeCV(
            alphas=_ridge_alphas(), cv=TimeSeriesSplit(n_splits=n_splits)
        ).fit(Xs, y_arr)
    except Exception:
        ridge_full = RidgeCV(alphas=_ridge_alphas()).fit(Xs, y_arr)

    xgb_full = None
    try:
        from xgboost import XGBRegressor

        xgb_full = XGBRegressor(**_xgb_params()).fit(X_arr, y_arr)
    except Exception:
        xgb_full = None

    return {
        "X_arr": X_arr,
        "y_arr": y_arr,
        "df_index": df.index,
        "feature_cols": feature_cols,
        "scaler": scaler,
        "ridge_full": ridge_full,
        "xgb_full": xgb_full,
    }


def _generate_oof_predictions(
    X_arr: np.ndarray,
    y_arr: np.ndarray,
    n_folds: int = _N_OOF_FOLDS,
) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """TimeSeriesSplit OOF predictions for Ridge + XGB.

    Returns (ridge_oof, xgb_oof, y_oof) — only the rows that were
    actually used as validation across folds.
    """
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    if len(y_arr) < 36:
        return None

    n = len(y_arr)
    tscv = TimeSeriesSplit(n_splits=n_folds)
    ridge_oof = np.full(n, np.nan)
    xgb_oof = np.full(n, np.nan)

    have_xgb = True
    try:
        from xgboost import XGBRegressor  # noqa: F401
    except Exception:
        have_xgb = False

    for tr_idx, va_idx in tscv.split(X_arr):
        if len(tr_idx) < 24:
            continue
        Xtr = X_arr[tr_idx]
        ytr = y_arr[tr_idx]
        Xva = X_arr[va_idx]

        # Ridge
        try:
            sc = StandardScaler().fit(Xtr)
            Xtr_s = sc.transform(Xtr)
            Xva_s = sc.transform(Xva)
            inner_n = min(3, max(2, len(tr_idx) // 60))
            try:
                rcv = RidgeCV(
                    alphas=_ridge_alphas(),
                    cv=TimeSeriesSplit(n_splits=inner_n),
                ).fit(Xtr_s, ytr)
            except Exception:
                rcv = RidgeCV(alphas=_ridge_alphas()).fit(Xtr_s, ytr)
            ridge_oof[va_idx] = rcv.predict(Xva_s)
        except Exception:
            pass

        # XGB
        if have_xgb:
            try:
                from xgboost import XGBRegressor

                xm = XGBRegressor(**_xgb_params()).fit(Xtr, ytr)
                xgb_oof[va_idx] = xm.predict(Xva)
            except Exception:
                pass

    mask = np.isfinite(ridge_oof) & np.isfinite(xgb_oof)
    if mask.sum() < 6:
        # Not enough OOF rows for a meta-learner.
        return None
    return ridge_oof[mask], xgb_oof[mask], y_arr[mask]


def _fit_meta(
    ridge_oof: np.ndarray, xgb_oof: np.ndarray, y_oof: np.ndarray
):
    """Fit a Ridge meta-learner on OOF base predictions.

    Returns (meta_model, meta_resid_std). Falls back gracefully if the
    fit explodes (rare, but the OOF set is tiny so be careful).
    """
    from sklearn.linear_model import RidgeCV

    M = np.stack([ridge_oof, xgb_oof], axis=1)
    try:
        meta = RidgeCV(alphas=_meta_alphas()).fit(M, y_oof)
        resid = y_oof - meta.predict(M)
        std = float(np.std(resid))
        if not np.isfinite(std) or std <= 0:
            std = 0.20
        return meta, max(std, _RESID_FLOOR)
    except Exception:
        return None, 0.20


# --------------------------- the strategy -----------------------------


class ChampionStrategy(ForecastStrategy):
    """Per-horizon stacking over Ridge + XGB on Agent C's enriched features."""

    name = "champion"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            try:
                return self._simple_blend(panel, horizon)
            except Exception:
                return self._naive(panel, horizon)

    # ---------- main path: enriched features + per-horizon stacking ----------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full, y_full = _build_rich_features(panel)
        # Drop rows where target is missing entirely (we still need rows
        # where features are present; per-horizon alignment handles target shifts).
        if X_full.empty or y_full.dropna().empty:
            return self._simple_blend(panel, horizon)

        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._predict_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                yhat = _last_observed_mom(panel)
                resid_std = max(_empirical_mom_std(panel), 0.15)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * max(resid_std, _RESID_FLOOR)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Per-horizon: build (X_T, y_{T+h}), generate OOF base preds,
        fit Ridge meta, then push live-row base preds through meta."""
        bundle = _fit_base_for_horizon(X_full, y_full, h)
        if bundle is None:
            # Not enough rows; fall back to last MoM at this horizon.
            return _last_observed_mom_y(y_full), max(_empirical_mom_std_y(y_full), 0.15)

        feature_cols = bundle["feature_cols"]
        scaler = bundle["scaler"]
        ridge_full = bundle["ridge_full"]
        xgb_full = bundle["xgb_full"]
        X_arr = bundle["X_arr"]
        y_arr = bundle["y_arr"]

        # Live feature vector for inference.
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)
        x_live_s = scaler.transform(x_live)

        # Live base predictions (full-fit models).
        ridge_pred = float(ridge_full.predict(x_live_s)[0])
        xgb_pred = (
            float(xgb_full.predict(x_live)[0]) if xgb_full is not None else np.nan
        )

        # OOF predictions for stacking.
        meta = None
        meta_resid_std = None
        if xgb_full is not None and not np.isnan(xgb_pred):
            oof = _generate_oof_predictions(X_arr, y_arr, n_folds=_N_OOF_FOLDS)
            if oof is not None:
                ridge_oof, xgb_oof, y_oof = oof
                meta, meta_resid_std = _fit_meta(ridge_oof, xgb_oof, y_oof)

        if meta is not None and meta_resid_std is not None:
            # Stacking path: push base predictions through the meta-Ridge.
            base_vec = np.array([[ridge_pred, xgb_pred]], dtype=float)
            try:
                yhat = float(meta.predict(base_vec)[0])
                # Sanity-check the stacked output: if it explodes, revert to blend.
                if not np.isfinite(yhat) or abs(yhat) > 5.0:
                    raise RuntimeError("meta produced absurd output")
                return yhat, meta_resid_std
            except Exception:
                pass

        # Fallback within this horizon: 50/50 blend (Agent B style).
        if xgb_full is not None and np.isfinite(xgb_pred):
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            ridge_resid = y_arr - ridge_full.predict(scaler.transform(X_arr))
            xgb_resid = y_arr - xgb_full.predict(X_arr)
            blended_resid = 0.5 * ridge_resid + 0.5 * xgb_resid
            std = float(np.std(blended_resid))
            return yhat, max(std, _RESID_FLOOR)

        # Ridge-only fallback.
        ridge_resid = y_arr - ridge_full.predict(scaler.transform(X_arr))
        std = float(np.std(ridge_resid))
        return ridge_pred, max(std, _RESID_FLOOR)

    # ---------- second-tier fallback: simple per-horizon blend (no stacking) ----

    def _simple_blend(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Just a 50/50 Ridge+XGB blend per horizon, on enriched features.

        Used when meta-learner stacking can't be built (small panel, etc.).
        """
        X_full, y_full = _build_rich_features(panel)
        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                bundle = _fit_base_for_horizon(X_full, y_full, h)
                if bundle is None:
                    raise RuntimeError("base bundle missing")
                fc = bundle["feature_cols"]
                sc = bundle["scaler"]
                rf = bundle["ridge_full"]
                xf = bundle["xgb_full"]
                X_arr = bundle["X_arr"]
                y_arr = bundle["y_arr"]

                x_live = live_row[fc].values.astype(float).reshape(1, -1)
                rp = float(rf.predict(sc.transform(x_live))[0])
                if xf is not None:
                    xp = float(xf.predict(x_live)[0])
                    yhat = 0.5 * rp + 0.5 * xp
                    rr = y_arr - rf.predict(sc.transform(X_arr))
                    xr = y_arr - xf.predict(X_arr)
                    std = float(np.std(0.5 * rr + 0.5 * xr))
                else:
                    yhat = rp
                    rr = y_arr - rf.predict(sc.transform(X_arr))
                    std = float(np.std(rr))
                std = max(std, _RESID_FLOOR)
            except Exception:
                yhat = _last_observed_mom(panel)
                std = max(_empirical_mom_std(panel), 0.15)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread
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


# ---- module-level helpers used by the per-horizon fallback path ----

def _last_observed_mom_y(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std_y(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())
