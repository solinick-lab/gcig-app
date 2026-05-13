"""Agent QQ — Big-data XGBoost on the WIDE panel (round 5).

Round 5 angle: kitchen-sink-but-bigger. The panel has been expanded to
~37 series. Build a feature matrix that, for EVERY column in the panel,
computes:

  * MoM lag 1
  * YoY lag 1
  * 3mo lag 1

That gives ~110+ features, which is a lot for a monthly target with
only a few hundred rows of history. But trees are good at variable
selection and we lean into that with heavy column subsampling
(colsample_bytree=0.5) and modest depth (max_depth=4). The XGBRegressor
is direct multi-step (one model per horizon) with n_estimators=600 and
learning_rate=0.03 for fine-grained shrinkage.

For stability we blend in a Ridge(alpha=10) trained on the same matrix
(60% XGB / 40% Ridge — XGB-favored). Ridge handles the linear part,
XGB handles non-linearities and interactions.

Some new series in the wide panel may have shorter histories than CPI.
We:
  - Drop columns whose feature transformations are entirely NaN.
  - ffill(limit=2) the live row so a missing latest value doesn't kill
    the prediction.

80% bands come from training-residual std with sqrt(h) widening.
Everything is wrapped in try/except with a persistence fallback so a
single bad cut doesn't tank the race.
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

_Z80 = 1.2816                 # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5           # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5            # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10           # don't let intervals collapse on tight fits
_MIN_TRAIN_ROWS = 36

# Ensemble blend
_W_XGB = 0.60
_W_RIDGE = 0.40

# XGB params — heavy column subsampling because we now have many features.
_XGB_PARAMS = dict(
    n_estimators=600,
    max_depth=4,
    learning_rate=0.03,
    subsample=0.85,
    colsample_bytree=0.5,
    reg_lambda=1.0,
    objective="reg:squarederror",
    n_jobs=1,
    verbosity=0,
)

_RIDGE_ALPHA = 10.0


# ---- feature builder -----------------------------------------------


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _three_mo(s: pd.Series) -> pd.Series:
    return (s / s.shift(3) - 1.0) * 100.0


def _build_wide_features(panel: pd.DataFrame) -> pd.DataFrame:
    """For every column in panel, emit MoM lag1, YoY lag1, 3mo lag1.

    Also adds month_sin/cos calendar features. Returns a DataFrame
    aligned to panel.index — caller is responsible for dropping NaN
    rows when building (X, y) supervised pairs.
    """
    rows: dict[str, pd.Series] = {}

    # Auto-discover every column. This way a wider panel just yields
    # more features automatically — no hard-coded list of FRED IDs.
    for col_name in panel.columns:
        col = panel[col_name]
        # Skip columns that are entirely NaN or have fewer than 13
        # non-NaN values (can't compute YoY without 13).
        if col.dropna().shape[0] < 13:
            continue
        # MoM lag 1 — short-run momentum
        rows[f"{col_name}_mom_lag1"] = _mom(col).shift(1)
        # YoY lag 1 — strong for shelter, wages, expectations
        rows[f"{col_name}_yoy_lag1"] = _yoy(col).shift(1)
        # 3mo lag 1 — smoother than 1mo, captures slow-moving pressure
        rows[f"{col_name}_3mo_lag1"] = _three_mo(col).shift(1)

    # Add deeper CPI lags so the autoregressive recursion has memory.
    cpi = panel.get(TARGET.fred_id)
    if cpi is not None:
        log_cpi = np.log(cpi)
        log_cpi_mom = (log_cpi - log_cpi.shift(1)) * 100.0
        rows["cpi_mom_lag1"] = log_cpi_mom.shift(1)
        rows["cpi_mom_lag2"] = log_cpi_mom.shift(2)
        rows["cpi_mom_lag3"] = log_cpi_mom.shift(3)
        rows["cpi_yoy_lag1"] = _yoy(cpi).shift(1)

    # Calendar features
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


class BigDataXgbStrategy(ForecastStrategy):
    """Big-feature direct-multi-step XGB + Ridge blend on the wide panel."""

    name = "agent_qq_bigxgb"

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

        X_full = _build_wide_features(panel)

        # Drop columns that are all-NaN (some new series may have shorter
        # history). After this we may still have NaN rows at the top of
        # the panel — those get dropped by the per-horizon supervised
        # join below.
        X_full = X_full.dropna(axis=1, how="all")
        if X_full.empty or X_full.shape[1] == 0:
            return self._naive(panel, horizon)

        # Live row — ffill(limit=2) so a slightly stale series doesn't
        # blank out the prediction.
        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                mean, resid_std = self._predict_one_horizon(
                    X_full, y_full, h, live_row
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
    # per-horizon: direct-multi-step XGB + Ridge blend
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Train XGB and Ridge on (X_T, y_{T+h-1}); return (mean, resid_std).

        Note: y_full is already y_{T+1} aligned (build_target gives MoM
        at T). For "h months ahead from cut", we shift y by (h-1) so the
        h=1 case uses the standard alignment.
        """
        # Direct multi-step: target is y at T + (h-1) so h=1 is the
        # next-month MoM (y_full at T already represents that).
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

        # Live feature row — reindex against feature_cols to handle the
        # case where some columns were dropped during the join.
        x_live = (
            live_row.reindex(feature_cols)
            .astype(float)
            .values.reshape(1, -1)
        )
        # Defensive NaN sweep on the live row.
        x_live = np.nan_to_num(x_live, nan=0.0, posinf=0.0, neginf=0.0)

        # ---- XGB
        xgb_pred = float("nan")
        xgb_train_pred = None
        try:
            from xgboost import XGBRegressor

            xgb = XGBRegressor(random_state=0, **_XGB_PARAMS)
            xgb.fit(X, y)
            xgb_pred = float(xgb.predict(x_live)[0])
            xgb_train_pred = xgb.predict(X)
        except Exception:
            xgb_pred = float("nan")

        # ---- Ridge (with StandardScaler — Ridge is scale-sensitive)
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

        # Blend — drop NaN members and renormalize weights.
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
        """Latest row, with ffill(limit=2) so a stale series doesn't blank it."""
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        # Don't dropna columns here — we'll fill 0 on the live row at
        # use site for any column that's still NaN.
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
