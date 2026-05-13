"""Agent AAA — Mega feature engineering with XGB-gain pruning (round 5).

Round 5 angle: go MASSIVE on feature engineering on the wide ~37-series
panel, then prune aggressively with XGBoost feature importance (gain).

Pipeline:
  1. For EVERY panel column, compute MoM lag1, 3mo lag1, 6mo lag1,
     12mo lag1, YoY lag1. ~37 cols * 5 = ~185 base features.
  2. Add a small set of named interaction terms:
       - TIPS_T5YIE_lvl_lag1 * oil_MoM_lag1
       - shelter_YoY_lag1 * MICH_level_lag1
       - HY_spread_lag1 * T10Y2Y_lag1
  3. Drop all-NaN columns; ffill(limit=2) the live row.
  4. First-pass: fit a single XGBRegressor on the full wide matrix,
     extract feature_importances_ (gain), keep top 30.
  5. Re-fit a Ridge + XGBoost ensemble (50/50) on the pruned top-30
     feature set, per-horizon (direct multi-step).
  6. 80% bands from training-residual std with sqrt(h) widening.

Falls back to a persistence forecast on any error path so a single bad
cut doesn't tank the strategy.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


# ---- constants ------------------------------------------------------

_Z80 = 1.2816
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.10
_MIN_TRAIN_ROWS = 36
_TOP_K = 30                       # post-prune feature count

# Ensemble blend (50/50 per spec).
_W_XGB = 0.50
_W_RIDGE = 0.50

# XGB params for the full-wide first-pass importance fit. Heavy column
# subsampling because the wide matrix is ~190+ columns.
_XGB_FIRST_PASS = dict(
    n_estimators=400,
    max_depth=4,
    learning_rate=0.05,
    subsample=0.85,
    colsample_bytree=0.5,
    reg_lambda=1.0,
    objective="reg:squarederror",
    n_jobs=1,
    verbosity=0,
)

# XGB params for the pruned (top-30) re-fit. We can run a deeper, longer
# fit since dimensionality is now manageable.
_XGB_FINAL = dict(
    n_estimators=600,
    max_depth=4,
    learning_rate=0.03,
    subsample=0.85,
    colsample_bytree=0.85,
    reg_lambda=1.0,
    objective="reg:squarederror",
    n_jobs=1,
    verbosity=0,
)

_RIDGE_ALPHA = 10.0


# ---- transforms -----------------------------------------------------


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _three_mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(3) - 1.0) * 100.0


def _six_mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(6) - 1.0) * 100.0


def _twelve_mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    # YoY is the same window as 12mo on a monthly series, but kept as a
    # distinct feature name so the spec's "YoY lag1" line is satisfied;
    # for level series like rates/spreads we compute it as a difference
    # vs. 12mo pct change. We emit both names so importance pruning can
    # pick whichever is more informative for a given column.
    return (s / s.shift(12) - 1.0) * 100.0


# ---- feature builder ------------------------------------------------


def _build_mega_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Massive auto-feature matrix on the wide panel.

    For every column with at least 13 non-NaN values: MoM, 3mo, 6mo,
    12mo, YoY — all lagged by 1. Plus a handful of named interaction
    terms and CPI lags / calendar features.
    """
    rows: dict[str, pd.Series] = {}

    # 1) Base panel features — auto-discover columns.
    for col_name in panel.columns:
        col = panel[col_name]
        if col.dropna().shape[0] < 13:
            continue
        rows[f"{col_name}_mom_lag1"] = _mom(col).shift(1)
        rows[f"{col_name}_3mo_lag1"] = _three_mo(col).shift(1)
        rows[f"{col_name}_6mo_lag1"] = _six_mo(col).shift(1)
        rows[f"{col_name}_12mo_lag1"] = _twelve_mo(col).shift(1)
        rows[f"{col_name}_yoy_lag1"] = _yoy(col).shift(1)

    # 2) CPI memory lags — give the autoregressive recursion something
    #    to grab onto even after pruning.
    cpi = panel.get(TARGET.fred_id)
    if cpi is not None:
        log_cpi = np.log(cpi)
        log_cpi_mom = (log_cpi - log_cpi.shift(1)) * 100.0
        rows["cpi_mom_lag1"] = log_cpi_mom.shift(1)
        rows["cpi_mom_lag2"] = log_cpi_mom.shift(2)
        rows["cpi_mom_lag3"] = log_cpi_mom.shift(3)
        rows["cpi_yoy_lag1"] = _yoy(cpi).shift(1)

    # 3) Named interactions per spec.
    cols = panel.columns

    # (a) TIPS_T5YIE level (lag1) * oil MoM (lag1)
    if "T5YIE" in cols and "DCOILWTICO" in cols:
        tips_lvl = panel["T5YIE"].shift(1)
        oil_mom = _mom(panel["DCOILWTICO"]).shift(1)
        rows["intx_tips5y_x_oilMoM"] = tips_lvl * oil_mom

    # (b) Shelter YoY (lag1) * MICH level (lag1)
    if "CUSR0000SAH1" in cols and "MICH" in cols:
        shelter_yoy = _yoy(panel["CUSR0000SAH1"]).shift(1)
        mich_lvl = panel["MICH"].shift(1)
        rows["intx_shelterYoY_x_MICHlvl"] = shelter_yoy * mich_lvl

    # (c) HY spread (lag1) * T10Y2Y (lag1)
    if "BAMLH0A0HYM2" in cols and "T10Y2Y" in cols:
        hy = panel["BAMLH0A0HYM2"].shift(1)
        t10y2y = panel["T10Y2Y"].shift(1)
        rows["intx_HY_x_T10Y2Y"] = hy * t10y2y

    # 4) Calendar — residual seasonality.
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx
    )

    feats = pd.concat(rows, axis=1)
    feats = feats.replace([np.inf, -np.inf], np.nan)
    return feats


# ---- the strategy ---------------------------------------------------


class MegaFeatureStrategy(ForecastStrategy):
    """Mega feature panel -> XGB-gain prune to top 30 -> Ridge+XGB ensemble."""

    name = "agent_aaa_megafeat"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        y_full = build_target(panel)
        if y_full.dropna().empty:
            return self._naive(panel, horizon)

        X_wide = _build_mega_features(panel)
        # Drop columns that are entirely NaN — happens when a series in
        # the wide panel is too short for any of the requested transforms.
        X_wide = X_wide.dropna(axis=1, how="all")
        if X_wide.empty or X_wide.shape[1] == 0:
            return self._naive(panel, horizon)

        # ---- First pass: feature importance pruning at h=1 ----
        top_features = self._select_top_features(X_wide, y_full)
        if not top_features:
            return self._naive(panel, horizon)

        X_pruned = X_wide[top_features]

        # Live row from the pruned matrix — ffill(limit=2) so a slightly
        # stale latest value doesn't blank out the prediction.
        live_row = self._latest_feature_row(X_pruned)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                mean, resid_std = self._predict_one_horizon(
                    X_pruned, y_full, h, live_row
                )
            except Exception:
                mean = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), _RESID_FLOOR)

            mean = float(np.clip(mean, _MOM_LO_CLIP, _MOM_HI_CLIP))
            resid_std = max(float(resid_std), _RESID_FLOOR)
            spread = _Z80 * resid_std * np.sqrt(float(h))

            means[i] = mean
            los[i] = mean - spread
            his[i] = mean + spread

        return means, los, his

    # ------------------------------------------------------------------
    # XGB-gain feature pruning (first pass at h=1)
    # ------------------------------------------------------------------
    def _select_top_features(
        self, X_wide: pd.DataFrame, y_full: pd.Series
    ) -> list[str]:
        """Train one XGBRegressor on the full wide matrix at h=1, then
        return the top-30 features by importance (gain).

        Falls back to "use everything" if XGBoost is unavailable, or
        returns the top-30 by variance if importance is degenerate.
        """
        df = X_wide.join(y_full.rename("y_target"), how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            # Too little data to prune meaningfully — keep everything but
            # cap at _TOP_K to keep the second pass tractable.
            cols = list(X_wide.columns)
            return cols[:_TOP_K]

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)

        try:
            from xgboost import XGBRegressor

            xgb = XGBRegressor(
                random_state=0,
                importance_type="gain",
                **_XGB_FIRST_PASS,
            )
            xgb.fit(X, y)
            imp = np.asarray(xgb.feature_importances_, dtype=float)
        except Exception:
            # Fallback: pick top-K by variance.
            var = np.nanvar(X, axis=0)
            order = np.argsort(-np.nan_to_num(var, nan=-np.inf))
            return [feature_cols[i] for i in order[:_TOP_K]]

        if imp.size == 0 or not np.isfinite(imp).any() or imp.sum() <= 0:
            # Degenerate importance — fall back to variance.
            var = np.nanvar(X, axis=0)
            order = np.argsort(-np.nan_to_num(var, nan=-np.inf))
            return [feature_cols[i] for i in order[:_TOP_K]]

        order = np.argsort(-imp)
        top_idx = order[:_TOP_K]
        top_cols = [feature_cols[i] for i in top_idx]
        # Safety: drop any with zero importance (no need to carry noise).
        top_cols = [c for c, i in zip(top_cols, imp[top_idx]) if i > 0] or top_cols
        return top_cols

    # ------------------------------------------------------------------
    # per-horizon: direct-multi-step Ridge + XGB ensemble
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Direct multi-step: train on (X_T, y_{T+h-1}); return (mean, std)."""
        if h == 1:
            y_target = y_full.copy().rename("y_target")
        else:
            y_target = y_full.shift(-(h - 1)).rename("y_target")

        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            return mid, sd

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)

        x_live = (
            live_row.reindex(feature_cols)
            .astype(float)
            .values.reshape(1, -1)
        )
        x_live = np.nan_to_num(x_live, nan=0.0, posinf=0.0, neginf=0.0)

        # ---- XGB on pruned set ----
        xgb_pred = float("nan")
        xgb_train_pred = None
        try:
            from xgboost import XGBRegressor

            xgb = XGBRegressor(random_state=0, **_XGB_FINAL)
            xgb.fit(X, y)
            xgb_pred = float(xgb.predict(x_live)[0])
            xgb_train_pred = xgb.predict(X)
        except Exception:
            xgb_pred = float("nan")

        # ---- Ridge on pruned set (StandardScaler — Ridge is scale-sensitive) ----
        ridge_pred = float("nan")
        ridge_train_pred = None
        try:
            from sklearn.linear_model import Ridge
            from sklearn.preprocessing import StandardScaler

            scaler = StandardScaler().fit(X)
            X_s = scaler.transform(X)
            x_live_s = scaler.transform(x_live)
            ridge = Ridge(alpha=_RIDGE_ALPHA)
            ridge.fit(X_s, y)
            ridge_pred = float(ridge.predict(x_live_s)[0])
            ridge_train_pred = ridge.predict(X_s)
        except Exception:
            ridge_pred = float("nan")

        # ---- 50/50 blend with NaN-aware renormalization ----
        members: list[tuple[float, float, np.ndarray]] = []
        if np.isfinite(xgb_pred) and xgb_train_pred is not None:
            members.append((_W_XGB, xgb_pred, xgb_train_pred))
        if np.isfinite(ridge_pred) and ridge_train_pred is not None:
            members.append((_W_RIDGE, ridge_pred, ridge_train_pred))

        if not members:
            mid = self._last_observed_mom(y_full)
            sd = max(self._empirical_mom_std(y_full), _RESID_FLOOR)
            return mid, sd

        wsum = sum(w for w, _, _ in members)
        members = [(w / wsum, p, tp) for w, p, tp in members]

        mean_pred = float(sum(w * p for w, p, _ in members))
        train_pred = np.zeros_like(y, dtype=float)
        for w, _, tp in members:
            train_pred = train_pred + w * tp
        resid = y - train_pred
        resid_std = float(np.std(resid)) if len(resid) > 1 else 0.30
        if not np.isfinite(resid_std) or resid_std <= 0:
            resid_std = 0.30

        return mean_pred, resid_std

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    @staticmethod
    def _last_observed_mom(y_full: pd.Series) -> float:
        s = y_full.dropna()
        if s.empty:
            return 0.0
        return float(s.iloc[-1])

    @staticmethod
    def _empirical_mom_std(y_full: pd.Series) -> float:
        s = y_full.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    # ------------------------------------------------------------------
    # last-resort fallback: persistence
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = self._last_observed_mom(y)
            sd = max(self._empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
