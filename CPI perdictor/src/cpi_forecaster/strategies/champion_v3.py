"""Champion v3: per-horizon meta-Ridge stacking of the top three contestants.

Combines the three best-performing strategies in the race so far:

  1. **Quantile (q=0.5 median)**: GradientBoostingRegressor with quantile loss
     trained on (build_features(panel), build_target(panel).shift(-h)).
     Strong at h3 (far-term) — the GBR captures non-linear interactions
     and the median is robust to heavy tails / shock months.

  2. **Bagging-Ridge**: BaggingRegressor over Ridge on the standard feature
     matrix. 50 bootstraps with 0.85 sample/feature subsampling drives
     down variance — strongest near-term (h1).

  3. **Champion-style enriched Ridge**: Ridge on the enriched feature
     matrix (PPI-CPI spread, oil*level, shelter MA, wage gap, MICH
     level/change, USD passthrough, etc.) — adds rich macro signal that
     the standard features miss.

For each horizon h in {1, 2, 3} (or up to whatever the caller asks for):
   1. Generate OOF predictions on the training panel via TimeSeriesSplit
      (3 folds) for each base learner aligned to (X_T, y_{T+h}).
   2. Fit a Ridge meta-learner per horizon on the OOF triplets -> actual MoM.
   3. At inference: refit base learners on the full panel, predict the
      live row, push through meta-Ridge.

Intervals: take the median absolute residual from the meta-Ridge OOF
residuals at each horizon, multiply by 1.4826 (MAD->sigma scale factor)
and z=1.2816 for 80% bands, with a floor of 0.10 MoM% per sqrt(h).

Defensive design: every base learner is wrapped in try/except. If
stacking can't be built (too few rows / OOF fold failures) we fall back
to a simple average of the available base predictions; if those fail
we fall back to the last observed MoM persistence forecast. The race
contract is no exceptions.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import FEATURES, TARGET


# Suppress noisy convergence / future warnings from sklearn + xgb.
warnings.filterwarnings("ignore")


# ----------------------------- constants ---------------------------------

_Z80 = 1.2816                 # one-sided z for an 80% interval
_MAD_SCALE = 1.4826           # MAD -> sigma scale under normality
_N_OOF_FOLDS = 3              # TimeSeriesSplit folds for OOF stacking
_MIN_TRAIN_ROWS = 36          # below this we don't bother fitting bases
_MOM_LO_CLIP = -1.5           # MoM % floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM % ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let the MoM% interval collapse

# Base-learner config — these mirror the contestant strategies they
# emulate, kept here so we don't import from sibling files.
_GBR_PARAMS = dict(
    loss="quantile",
    alpha=0.5,
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.85,
    min_samples_leaf=5,
    random_state=0,
)

_BAG_N_ESTIMATORS = 50
_BAG_MAX_SAMPLES = 0.85
_BAG_MAX_FEATURES = 0.85
_RIDGE_ALPHA = 1.0
_RANDOM_STATE = 0


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


# --------------- enriched feature matrix (champion-style) ----------------

def _build_rich_features(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Build the enriched feature matrix (champion-style) and aligned target.

    Re-implemented locally per the rules — do NOT import from champion.py.
    """
    rows: dict[str, pd.Series] = {}

    cpi = panel[TARGET.fred_id]
    cpi_mom = _log_mom(cpi)
    target = cpi_mom.rename("y_mom_pct")
    cpi_yoy = _yoy(cpi)

    # CPI own-history features (lagged).
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

    # Realized CPI volatility regime.
    cpi_vol_12 = cpi_mom.rolling(12).std()
    rows["cpi_vol12_lag1"] = cpi_vol_12.shift(1)
    long_run_median = cpi_vol_12.expanding(min_periods=24).median()
    crisis = (cpi_vol_12 > long_run_median).astype(float)
    rows["cpi_vol_regime_lag1"] = crisis.shift(1)

    # Per-series lag-1 standard transforms.
    for f in FEATURES:
        if f.fred_id not in panel.columns:
            continue
        col = panel[f.fred_id]
        rows[f"{f.fred_id}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{f.fred_id}_3mo_lag1"] = _pct_change_n(col, 3).shift(1)
        rows[f"{f.fred_id}_yoy_lag1"] = _yoy(col).shift(1)

    # PPI-CPI spread (cost passthrough).
    if "PPIACO" in panel.columns:
        ppi_yoy = _yoy(panel["PPIACO"])
        rows["ppi_cpi_spread_lag1"] = (ppi_yoy - cpi_yoy).shift(1)
        rows["ppi_cpi_spread_chg3_lag1"] = (
            (ppi_yoy - cpi_yoy) - (ppi_yoy - cpi_yoy).shift(3)
        ).shift(1)
    if "PPIFIS" in panel.columns:
        ppifis_yoy = _yoy(panel["PPIFIS"])
        rows["ppifis_cpi_spread_lag1"] = (ppifis_yoy - cpi_yoy).shift(1)

    # Oil/gas: momentum * level (asymmetric passthrough).
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

    # Shelter: 6-mo MA of MoM (rents are sticky).
    if "CUSR0000SAH1" in panel.columns:
        shelter = panel["CUSR0000SAH1"]
        shelter_mom = _mom(shelter)
        rows["shelter_mom_ma6_lag1"] = shelter_mom.rolling(6).mean().shift(1)
        rows["shelter_mom_ma12_lag1"] = shelter_mom.rolling(12).mean().shift(1)
        rows["shelter_accel_lag1"] = (
            shelter_mom.rolling(3).mean() - shelter_mom.rolling(3).mean().shift(3)
        ).shift(1)

    # Home prices: passthrough into shelter is delayed ~12-18 mo.
    if "CSUSHPISA" in panel.columns:
        hpi_yoy = _yoy(panel["CSUSHPISA"])
        rows["hpi_yoy_lag12"] = hpi_yoy.shift(12)
        rows["hpi_yoy_lag18"] = hpi_yoy.shift(18)

    # Wage-price spiral.
    if "CES0500000003" in panel.columns:
        ahe_yoy = _yoy(panel["CES0500000003"])
        rows["wage_price_spread_lag1"] = (ahe_yoy - cpi_yoy).shift(1)
        if "UNRATE" in panel.columns:
            unrate = panel["UNRATE"]
            rows["wage_x_tightness_lag1"] = (ahe_yoy * (10.0 - unrate)).shift(1)

    # M2 growth (monetary impulse).
    if "M2SL" in panel.columns:
        m2 = panel["M2SL"]
        rows["m2_yoy_lag1"] = _yoy(m2).shift(1)
        rows["m2_3mo_lag1"] = _pct_change_n(m2, 3).shift(1)
        if "INDPRO" in panel.columns:
            indpro_yoy = _yoy(panel["INDPRO"])
            rows["m2_x_indpro_lag1"] = (_yoy(m2) * indpro_yoy).shift(1)

    # Inflation expectations: level AND change.
    if "MICH" in panel.columns:
        mich = panel["MICH"]
        rows["mich_level_lag1"] = mich.shift(1)
        rows["mich_chg3_lag1"] = _diff_n(mich, 3).shift(1)
        rows["mich_chg6_lag1"] = _diff_n(mich, 6).shift(1)
        rows["mich_vs_cpi_lag1"] = (mich - cpi_yoy).shift(1)

    # USD index: import price passthrough.
    if "DTWEXBGS" in panel.columns:
        usd = panel["DTWEXBGS"]
        rows["usd_chg6_lag1"] = _pct_change_n(usd, 6).shift(1)
        rows["usd_chg12_lag1"] = _pct_change_n(usd, 12).shift(1)
        rows["usd_chg6_lag6"] = _pct_change_n(usd, 6).shift(6)

    # 10Y real-rate proxy.
    if "DGS10" in panel.columns:
        dgs10 = panel["DGS10"]
        rows["real_rate_proxy_lag1"] = (dgs10 - cpi_yoy).shift(1)
        rows["dgs10_chg6_lag1"] = _diff_n(dgs10, 6).shift(1)

    # Demand pressure.
    if "INDPRO" in panel.columns:
        indpro = panel["INDPRO"]
        rows["indpro_3mo_lag1"] = _pct_change_n(indpro, 3).shift(1)
    if "RSAFS" in panel.columns:
        rsafs = panel["RSAFS"]
        rows["rsafs_3mo_lag1"] = _pct_change_n(rsafs, 3).shift(1)

    # Unemployment slack/tightness.
    if "UNRATE" in panel.columns:
        unrate = panel["UNRATE"]
        unrate_trend = unrate.rolling(60, min_periods=24).mean()
        rows["unrate_gap_lag1"] = (unrate - unrate_trend).shift(1)
        rows["unrate_chg6_lag1"] = _diff_n(unrate, 6).shift(1)

    # Calendar (residual seasonality).
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
    """Most recent feature row for prediction — small ffill for ragged edge."""
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


# -------------------------- base learners ------------------------------

def _fit_quantile(X_arr: np.ndarray, y_arr: np.ndarray):
    """Fit the q=0.5 GradientBoostingRegressor (median quantile loss)."""
    from sklearn.ensemble import GradientBoostingRegressor

    return GradientBoostingRegressor(**_GBR_PARAMS).fit(X_arr, y_arr)


def _fit_bagging_ridge(X_arr: np.ndarray, y_arr: np.ndarray):
    """Fit BaggingRegressor over a Ridge pipeline (with internal scaler)."""
    from sklearn.ensemble import BaggingRegressor
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline

    base = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            ("ridge", Ridge(alpha=_RIDGE_ALPHA)),
        ]
    )
    try:
        return BaggingRegressor(
            estimator=base,
            n_estimators=_BAG_N_ESTIMATORS,
            max_samples=_BAG_MAX_SAMPLES,
            max_features=_BAG_MAX_FEATURES,
            bootstrap=True,
            bootstrap_features=False,
            n_jobs=1,
            random_state=_RANDOM_STATE,
        ).fit(X_arr, y_arr)
    except TypeError:
        # Older sklearn used 'base_estimator' kwarg.
        return BaggingRegressor(
            base_estimator=base,
            n_estimators=_BAG_N_ESTIMATORS,
            max_samples=_BAG_MAX_SAMPLES,
            max_features=_BAG_MAX_FEATURES,
            bootstrap=True,
            bootstrap_features=False,
            n_jobs=1,
            random_state=_RANDOM_STATE,
        ).fit(X_arr, y_arr)


def _fit_rich_ridge(X_arr: np.ndarray, y_arr: np.ndarray):
    """Fit a (scaler+RidgeCV) pipeline on the enriched features."""
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    scaler = StandardScaler().fit(X_arr)
    Xs = scaler.transform(X_arr)
    n_splits = min(4, max(2, len(y_arr) // 60))
    alphas = np.logspace(-3, 3, 19)
    try:
        ridge = RidgeCV(
            alphas=alphas, cv=TimeSeriesSplit(n_splits=n_splits)
        ).fit(Xs, y_arr)
    except Exception:
        ridge = RidgeCV(alphas=alphas).fit(Xs, y_arr)
    return scaler, ridge


# ---------------- per-horizon supervised pair builder ------------------

def _supervised_pair(
    X_full: pd.DataFrame, y_full: pd.Series, h: int
) -> tuple[np.ndarray, np.ndarray, list[str], pd.DatetimeIndex] | None:
    """Align (X_T, y_{T+h}) and drop rows with any NaN. Returns None if too few."""
    y_target = y_full.shift(-h).rename("y_target")
    df = X_full.join(y_target, how="inner").dropna()
    if len(df) < _MIN_TRAIN_ROWS:
        return None
    feature_cols = [c for c in df.columns if c != "y_target"]
    X_arr = df[feature_cols].values.astype(float)
    y_arr = df["y_target"].values.astype(float)
    return X_arr, y_arr, feature_cols, df.index


# ---------------------- OOF prediction generation ----------------------

def _oof_predict_quantile(
    X_arr: np.ndarray, y_arr: np.ndarray, n_folds: int
) -> np.ndarray:
    """TimeSeriesSplit OOF predictions for the quantile GBR."""
    from sklearn.model_selection import TimeSeriesSplit

    n = len(y_arr)
    out = np.full(n, np.nan)
    tscv = TimeSeriesSplit(n_splits=n_folds)
    for tr_idx, va_idx in tscv.split(X_arr):
        if len(tr_idx) < 24:
            continue
        try:
            m = _fit_quantile(X_arr[tr_idx], y_arr[tr_idx])
            out[va_idx] = m.predict(X_arr[va_idx])
        except Exception:
            pass
    return out


def _oof_predict_bagging(
    X_arr: np.ndarray, y_arr: np.ndarray, n_folds: int
) -> np.ndarray:
    """TimeSeriesSplit OOF predictions for the bagging-Ridge."""
    from sklearn.model_selection import TimeSeriesSplit

    n = len(y_arr)
    out = np.full(n, np.nan)
    tscv = TimeSeriesSplit(n_splits=n_folds)
    for tr_idx, va_idx in tscv.split(X_arr):
        if len(tr_idx) < 24:
            continue
        try:
            m = _fit_bagging_ridge(X_arr[tr_idx], y_arr[tr_idx])
            out[va_idx] = m.predict(X_arr[va_idx])
        except Exception:
            pass
    return out


def _oof_predict_rich_ridge(
    X_arr: np.ndarray, y_arr: np.ndarray, n_folds: int
) -> np.ndarray:
    """TimeSeriesSplit OOF predictions for the enriched-features Ridge."""
    from sklearn.model_selection import TimeSeriesSplit

    n = len(y_arr)
    out = np.full(n, np.nan)
    tscv = TimeSeriesSplit(n_splits=n_folds)
    for tr_idx, va_idx in tscv.split(X_arr):
        if len(tr_idx) < 24:
            continue
        try:
            sc, rg = _fit_rich_ridge(X_arr[tr_idx], y_arr[tr_idx])
            out[va_idx] = rg.predict(sc.transform(X_arr[va_idx]))
        except Exception:
            pass
    return out


# ----------------------- meta-learner ----------------------------------

def _fit_meta(M_oof: np.ndarray, y_oof: np.ndarray):
    """Fit a Ridge meta-learner on OOF base predictions.

    Returns (meta, mad_sigma, oof_resid_std). MAD-based sigma is more
    robust to a single-fold blowup than plain std.
    """
    from sklearn.linear_model import RidgeCV

    alphas = np.array([0.05, 0.1, 0.3, 1.0, 3.0, 10.0])
    try:
        meta = RidgeCV(alphas=alphas).fit(M_oof, y_oof)
        resid = y_oof - meta.predict(M_oof)
        mad = float(np.median(np.abs(resid - np.median(resid))))
        mad_sigma = _MAD_SCALE * mad
        std_sigma = float(np.std(resid))
        # Use MAD when it's positive; else std fallback.
        sigma = mad_sigma if (np.isfinite(mad_sigma) and mad_sigma > 0) else std_sigma
        if not np.isfinite(sigma) or sigma <= 0:
            sigma = 0.20
        return meta, max(sigma, _RESID_FLOOR)
    except Exception:
        return None, 0.20


# --------------------------- the strategy -----------------------------


class ChampionV3Strategy(ForecastStrategy):
    """Per-horizon Ridge meta-stacking of quantile + bagging-ridge + enriched-ridge."""

    name = "champion_v3"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            try:
                return self._simple_average(panel, horizon)
            except Exception:
                return self._naive(panel, horizon)

    # ---------------- main path: per-horizon stacking -----------------

    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Standard (build_features) matrix — used by quantile + bagging.
        X_std = build_features(panel)
        y_std = build_target(panel)
        # Enriched feature matrix — used by the rich-Ridge base.
        X_rich, y_rich = _build_rich_features(panel)

        if X_std.empty or y_std.dropna().empty or X_rich.empty:
            return self._simple_average(panel, horizon)

        try:
            live_std = _latest_feature_row(X_std)
        except Exception:
            return self._simple_average(panel, horizon)
        try:
            live_rich = _latest_feature_row(X_rich)
        except Exception:
            live_rich = None  # rich Ridge will be skipped if unavailable

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, sigma = self._predict_one_horizon(
                    X_std, y_std, X_rich, y_rich, h, live_std, live_rich
                )
            except Exception:
                yhat = _last_observed_mom(panel)
                sigma = max(_empirical_mom_std(panel), 0.15)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            # 80% interval. Per-horizon floor scales as sqrt(h) so far-out
            # forecasts don't pretend to be tighter than they are.
            floor_h = _RESID_FLOOR * np.sqrt(h)
            spread = _Z80 * max(sigma, floor_h)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    def _predict_one_horizon(
        self,
        X_std: pd.DataFrame,
        y_std: pd.Series,
        X_rich: pd.DataFrame,
        y_rich: pd.Series,
        h: int,
        live_std: pd.Series,
        live_rich: pd.Series | None,
    ) -> tuple[float, float]:
        """Per-horizon stacking: OOF base preds -> meta-Ridge -> yhat."""
        # ---- Build supervised pairs for each base model.
        std_pair = _supervised_pair(X_std, y_std, h)
        rich_pair = _supervised_pair(X_rich, y_rich, h)
        if std_pair is None and rich_pair is None:
            # Fall through to per-horizon naive.
            return _last_observed_mom_y(y_std), max(_empirical_mom_std_y(y_std), 0.15)

        # ---- Fit base models on full (per-horizon) training slices.
        q_full = bag_full = None
        std_feature_cols: list[str] = []
        std_index: pd.DatetimeIndex | None = None
        std_X_arr = std_y_arr = None
        if std_pair is not None:
            std_X_arr, std_y_arr, std_feature_cols, std_index = std_pair
            try:
                q_full = _fit_quantile(std_X_arr, std_y_arr)
            except Exception:
                q_full = None
            try:
                bag_full = _fit_bagging_ridge(std_X_arr, std_y_arr)
            except Exception:
                bag_full = None

        rich_full = None
        rich_scaler = None
        rich_feature_cols: list[str] = []
        rich_index: pd.DatetimeIndex | None = None
        rich_X_arr = rich_y_arr = None
        if rich_pair is not None and live_rich is not None:
            rich_X_arr, rich_y_arr, rich_feature_cols, rich_index = rich_pair
            try:
                rich_scaler, rich_full = _fit_rich_ridge(rich_X_arr, rich_y_arr)
            except Exception:
                rich_full = None
                rich_scaler = None

        # ---- Live base predictions.
        live_preds: dict[str, float] = {}
        if q_full is not None and std_feature_cols:
            try:
                x_live = (
                    live_std[std_feature_cols].values.astype(float).reshape(1, -1)
                )
                live_preds["quantile"] = float(q_full.predict(x_live)[0])
            except Exception:
                pass
        if bag_full is not None and std_feature_cols:
            try:
                x_live = (
                    live_std[std_feature_cols].values.astype(float).reshape(1, -1)
                )
                live_preds["bagging"] = float(bag_full.predict(x_live)[0])
            except Exception:
                pass
        if rich_full is not None and rich_feature_cols and live_rich is not None:
            try:
                x_live_r = (
                    live_rich[rich_feature_cols].values.astype(float).reshape(1, -1)
                )
                live_preds["rich_ridge"] = float(
                    rich_full.predict(rich_scaler.transform(x_live_r))[0]
                )
            except Exception:
                pass

        if not live_preds:
            return _last_observed_mom_y(y_std), max(_empirical_mom_std_y(y_std), 0.15)

        # ---- Generate OOF predictions per base learner and align them.
        # We need predictions on the same set of training rows so the
        # meta-Ridge sees a consistent (n, k) matrix. Use the std panel's
        # index as the reference and look up the rich OOF by date when
        # available.
        meta = None
        meta_sigma = None
        ordered_keys = [k for k in ("quantile", "bagging", "rich_ridge") if k in live_preds]
        if std_X_arr is not None and std_y_arr is not None and std_index is not None:
            oof_cols: dict[str, pd.Series] = {}
            if "quantile" in live_preds and q_full is not None:
                try:
                    oof_q = _oof_predict_quantile(std_X_arr, std_y_arr, _N_OOF_FOLDS)
                    oof_cols["quantile"] = pd.Series(oof_q, index=std_index)
                except Exception:
                    pass
            if "bagging" in live_preds and bag_full is not None:
                try:
                    oof_b = _oof_predict_bagging(std_X_arr, std_y_arr, _N_OOF_FOLDS)
                    oof_cols["bagging"] = pd.Series(oof_b, index=std_index)
                except Exception:
                    pass
            if (
                "rich_ridge" in live_preds
                and rich_X_arr is not None
                and rich_y_arr is not None
                and rich_index is not None
            ):
                try:
                    oof_r = _oof_predict_rich_ridge(rich_X_arr, rich_y_arr, _N_OOF_FOLDS)
                    oof_cols["rich_ridge"] = pd.Series(oof_r, index=rich_index)
                except Exception:
                    pass
            y_oof_series = pd.Series(std_y_arr, index=std_index, name="y")

            # Inner-join the OOF columns with y on date so all rows align.
            if oof_cols:
                oof_df = pd.concat(
                    {**oof_cols, "_y": y_oof_series}, axis=1, join="inner"
                ).dropna()
                if len(oof_df) >= 6 and len(oof_cols) >= 1:
                    base_keys = [k for k in ordered_keys if k in oof_df.columns]
                    if base_keys:
                        M = oof_df[base_keys].values.astype(float)
                        y_oof = oof_df["_y"].values.astype(float)
                        meta, meta_sigma = _fit_meta(M, y_oof)
                        # Some base learners might have OOF but no live pred
                        # or vice versa — restrict to keys present in BOTH.
                        ordered_keys = base_keys

        # ---- Push the live base predictions through the meta or fall back.
        if meta is not None and meta_sigma is not None:
            try:
                vec = np.array(
                    [[live_preds[k] for k in ordered_keys]], dtype=float
                )
                yhat = float(meta.predict(vec)[0])
                if not np.isfinite(yhat) or abs(yhat) > 5.0:
                    raise RuntimeError("meta produced absurd output")
                return yhat, meta_sigma
            except Exception:
                pass

        # Stacking unavailable -> simple average of whichever bases we have.
        vals = list(live_preds.values())
        yhat = float(np.mean(vals))
        sigma = max(_empirical_mom_std_y(y_std), _RESID_FLOOR)
        return yhat, sigma

    # ----------- second-tier fallback: simple base average ------------

    def _simple_average(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """No stacking — just average whichever base learners survive per horizon."""
        try:
            X_std = build_features(panel)
            y_std = build_target(panel)
        except Exception:
            return self._naive(panel, horizon)

        try:
            X_rich, y_rich = _build_rich_features(panel)
        except Exception:
            X_rich = pd.DataFrame()
            y_rich = pd.Series(dtype=float)

        try:
            live_std = _latest_feature_row(X_std)
        except Exception:
            return self._naive(panel, horizon)
        try:
            live_rich = _latest_feature_row(X_rich) if not X_rich.empty else None
        except Exception:
            live_rich = None

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            preds: list[float] = []
            try:
                std_pair = _supervised_pair(X_std, y_std, h)
                if std_pair is not None:
                    Xa, ya, fc, _ = std_pair
                    x_live = live_std[fc].values.astype(float).reshape(1, -1)
                    try:
                        m = _fit_quantile(Xa, ya)
                        preds.append(float(m.predict(x_live)[0]))
                    except Exception:
                        pass
                    try:
                        m = _fit_bagging_ridge(Xa, ya)
                        preds.append(float(m.predict(x_live)[0]))
                    except Exception:
                        pass
            except Exception:
                pass
            try:
                if not X_rich.empty and live_rich is not None:
                    rich_pair = _supervised_pair(X_rich, y_rich, h)
                    if rich_pair is not None:
                        Xa, ya, fc, _ = rich_pair
                        x_live = live_rich[fc].values.astype(float).reshape(1, -1)
                        try:
                            sc, rg = _fit_rich_ridge(Xa, ya)
                            preds.append(float(rg.predict(sc.transform(x_live))[0]))
                        except Exception:
                            pass
            except Exception:
                pass

            if preds:
                yhat = float(np.mean(preds))
            else:
                yhat = _last_observed_mom(panel)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            sd = max(_empirical_mom_std(panel), 0.15)
            floor_h = _RESID_FLOOR * np.sqrt(h)
            spread = _Z80 * max(sd, floor_h)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread
        return means, los, his

    # ---------------- last-resort fallback: persistence ---------------

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
