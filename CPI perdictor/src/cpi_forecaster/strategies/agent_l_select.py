"""Agent L: automatic feature selection over the enriched matrix.

The champion strategy uses a kitchen-sink-style enriched feature set
(50+ features). Many of those features are likely noise. This strategy
keeps the same feature engineering, but pares the matrix down via two
complementary selectors:

  (a) sklearn.feature_selection.mutual_info_regression — captures
      non-linear correlation with the target. We keep the top 15
      features by MI score.

  (b) LassoCV — an L1 regularised linear model. Features whose
      coefficients survive the L1 shrinkage are kept.

Selection rule: UNION of the two sets, capped at 20 features (MI rank
acts as the tie-breaker). UNION rather than intersection because the
two methods catch different things — MI catches non-linearities Lasso
can't see, and Lasso catches linear combinations whose pairwise MI
might be modest. Intersection felt too aggressive on a small panel;
UNION + a hard cap is the conservative middle ground.

Downstream: per-horizon Ridge + XGBoost (direct multi-step, like
Agent B), 50/50 ensemble per horizon, 80% interval from the residual
std with z=1.2816. Defensive: fit_and_predict NEVER raises.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..fred import FEATURES, TARGET


warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816               # one-sided z for 80% interval
_TOP_K_MI = 15              # how many features to keep from MI ranking
_MAX_FEATURES = 20          # hard cap on the union
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36


# ----------------------------- helpers ---------------------------------

def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s.clip(lower=1e-9)) - np.log(s.shift(1).clip(lower=1e-9))) * 100.0


def _pct_change_n(s: pd.Series, n: int) -> pd.Series:
    return (s / s.shift(n) - 1.0) * 100.0


def _diff_n(s: pd.Series, n: int) -> pd.Series:
    return s - s.shift(n)


# --------------------- Enriched feature construction ----------------------
# Verbatim from agent_c_features (the same matrix the champion uses).

def _build_rich_features(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Build the enriched feature matrix and aligned target."""
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

    # ---- Oil/gas: momentum * level ----
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

    # ---- Shelter ----
    if "CUSR0000SAH1" in panel.columns:
        shelter = panel["CUSR0000SAH1"]
        shelter_mom = _mom(shelter)
        rows["shelter_mom_ma6_lag1"] = shelter_mom.rolling(6).mean().shift(1)
        rows["shelter_mom_ma12_lag1"] = shelter_mom.rolling(12).mean().shift(1)
        rows["shelter_accel_lag1"] = (
            shelter_mom.rolling(3).mean() - shelter_mom.rolling(3).mean().shift(3)
        ).shift(1)

    # ---- Home prices ----
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

    # ---- M2 growth ----
    if "M2SL" in panel.columns:
        m2 = panel["M2SL"]
        rows["m2_yoy_lag1"] = _yoy(m2).shift(1)
        rows["m2_3mo_lag1"] = _pct_change_n(m2, 3).shift(1)
        if "INDPRO" in panel.columns:
            indpro_yoy = _yoy(panel["INDPRO"])
            rows["m2_x_indpro_lag1"] = (_yoy(m2) * indpro_yoy).shift(1)

    # ---- Inflation expectations ----
    if "MICH" in panel.columns:
        mich = panel["MICH"]
        rows["mich_level_lag1"] = mich.shift(1)
        rows["mich_chg3_lag1"] = _diff_n(mich, 3).shift(1)
        rows["mich_chg6_lag1"] = _diff_n(mich, 6).shift(1)
        rows["mich_vs_cpi_lag1"] = (mich - cpi_yoy).shift(1)

    # ---- USD index ----
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

    # ---- Unemployment slack ----
    if "UNRATE" in panel.columns:
        unrate = panel["UNRATE"]
        unrate_trend = unrate.rolling(60, min_periods=24).mean()
        rows["unrate_gap_lag1"] = (unrate - unrate_trend).shift(1)
        rows["unrate_chg6_lag1"] = _diff_n(unrate, 6).shift(1)

    # ---- Calendar ----
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


# ----------------------- feature selection -------------------

def _select_features(
    X_full: pd.DataFrame, y_full: pd.Series
) -> list[str]:
    """Pick a small set of features via MI + Lasso union, cap at _MAX_FEATURES.

    Selection happens once, on the h=1 supervised pair, using only data
    that is fully observed (no missing). Each downstream horizon then
    uses this same pared-down feature list.
    """
    from sklearn.feature_selection import mutual_info_regression
    from sklearn.linear_model import LassoCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    df = X_full.join(y_full.rename("y_target"), how="inner").dropna()
    if len(df) < _MIN_TRAIN_ROWS:
        # Fall back to using everything that's available.
        return list(X_full.columns)

    feature_cols = [c for c in df.columns if c != "y_target"]
    X_arr = df[feature_cols].values.astype(float)
    y_arr = df["y_target"].values.astype(float)

    # ---- (a) Mutual information ranking ----
    mi_ranked: list[str] = []
    mi_score_map: dict[str, float] = {}
    try:
        mi = mutual_info_regression(X_arr, y_arr, random_state=0)
        order = np.argsort(mi)[::-1]
        for j in order:
            name = feature_cols[j]
            mi_score_map[name] = float(mi[j])
            mi_ranked.append(name)
    except Exception:
        # If MI explodes for any reason, fall back to variance-ordering.
        mi_ranked = list(feature_cols)
        mi_score_map = {c: 0.0 for c in feature_cols}

    top_mi = mi_ranked[:_TOP_K_MI]

    # ---- (b) Lasso path: features with non-zero coefficients ----
    lasso_kept: list[str] = []
    try:
        scaler = StandardScaler().fit(X_arr)
        Xs = scaler.transform(X_arr)
        n_splits = min(4, max(2, len(df) // 60))
        try:
            lasso = LassoCV(
                cv=TimeSeriesSplit(n_splits=n_splits),
                max_iter=5000,
                random_state=0,
                n_alphas=30,
            ).fit(Xs, y_arr)
        except Exception:
            lasso = LassoCV(
                max_iter=5000, random_state=0, n_alphas=30
            ).fit(Xs, y_arr)
        coefs = lasso.coef_
        for j, c in enumerate(coefs):
            if abs(c) > 1e-8:
                lasso_kept.append(feature_cols[j])
    except Exception:
        lasso_kept = []

    # ---- Union, capped at _MAX_FEATURES (MI score breaks ties) ----
    union = list(dict.fromkeys(top_mi + lasso_kept))  # preserve order, dedupe
    if len(union) > _MAX_FEATURES:
        # Sort the union by MI score (desc) and trim.
        union.sort(key=lambda c: mi_score_map.get(c, 0.0), reverse=True)
        union = union[:_MAX_FEATURES]

    if not union:
        # Degenerate: keep the top-K MI features at minimum.
        union = top_mi if top_mi else list(feature_cols)[:_MAX_FEATURES]

    return union


# ----------------------- per-horizon training -------------------

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


def _fit_one_horizon(
    X_sel: pd.DataFrame,
    y_full: pd.Series,
    h: int,
    live_row: pd.Series,
) -> tuple[float, float]:
    """Train Ridge + XGB on (X_sel_T, y_{T+h}). Return (yhat, resid_std)."""
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    y_target = y_full.shift(-h).rename("y_target")
    df = X_sel.join(y_target, how="inner").dropna()
    if len(df) < _MIN_TRAIN_ROWS:
        raise RuntimeError("Not enough rows for this horizon.")

    feature_cols = [c for c in df.columns if c != "y_target"]
    X_arr = df[feature_cols].values.astype(float)
    y_arr = df["y_target"].values.astype(float)
    x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

    # Ridge with TS-CV alpha
    scaler = StandardScaler().fit(X_arr)
    Xs = scaler.transform(X_arr)
    x_live_s = scaler.transform(x_live)
    n_splits = min(5, max(2, len(df) // 60))
    try:
        ridge = RidgeCV(
            alphas=_ridge_alphas(), cv=TimeSeriesSplit(n_splits=n_splits)
        ).fit(Xs, y_arr)
    except Exception:
        ridge = RidgeCV(alphas=_ridge_alphas()).fit(Xs, y_arr)
    ridge_pred = float(ridge.predict(x_live_s)[0])
    ridge_resid = y_arr - ridge.predict(Xs)

    # XGB (best-effort)
    xgb_pred: float | None = None
    xgb_resid: np.ndarray | None = None
    try:
        from xgboost import XGBRegressor

        model = XGBRegressor(**_xgb_params()).fit(X_arr, y_arr)
        xgb_pred = float(model.predict(x_live)[0])
        xgb_resid = y_arr - model.predict(X_arr)
    except Exception:
        xgb_pred = None
        xgb_resid = None

    if xgb_pred is None or xgb_resid is None:
        yhat = ridge_pred
        resid = ridge_resid
    else:
        # 50/50 ensemble per horizon.
        yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
        resid = 0.5 * ridge_resid + 0.5 * xgb_resid

    resid_std = float(np.std(resid))
    return yhat, max(resid_std, _RESID_FLOOR)


# --------------------------- the strategy -----------------------------


class FeatureSelectionStrategy(ForecastStrategy):
    """Auto feature selection (MI + Lasso union, capped at 20) on top of
    the enriched matrix, with per-horizon Ridge+XGB direct multi-step.
    """

    name = "agent_l_select"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full, y_full = _build_rich_features(panel)
        if X_full.empty or y_full.dropna().empty:
            return self._naive(panel, horizon)

        # Pick the surviving features once on the in-sample data.
        selected = _select_features(X_full, y_full)
        X_sel_full = X_full[selected]

        live_row = _latest_feature_row(X_sel_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = _fit_one_horizon(
                    X_sel_full, y_full, h, live_row
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

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        last = _last_observed_mom(panel)
        sd = max(_empirical_mom_std(panel), 0.15)
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
