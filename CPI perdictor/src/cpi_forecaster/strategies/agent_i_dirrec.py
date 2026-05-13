"""DirRec hybrid strategy (Direct + Recursive).

The champion uses pure direct multi-step (one independent model per
horizon). Pure recursive feeds previous predictions back as inputs to
the lag features. DirRec is a hybrid: train the horizon-h model with
the previous-horizon's PREDICTION as an additional input feature. This
lets the model learn how to correct its own systematic biases.

Per-horizon pipeline:
  - h=1: features = X(T). Target = MoM(T+1).
  - h=2: features = X(T) plus h1-prediction at time T. Target = MoM(T+2).
  - h=3: features = X(T) plus h1- and h2-predictions at time T.
         Target = MoM(T+3).

The previous-horizon predictions used as TRAINING features are
generated via TimeSeriesSplit OOF predictions (no leakage). The
INFERENCE-time previous-horizon predictions come from this strategy's
own forecasts at earlier horizons in the same call.

Each horizon: 50/50 ensemble of Ridge + XGB (matches Agent B style).
Residual std drives 80% bands.

Defensive: fit_and_predict is wrapped in nested try/except. Falls back
to the plain direct multi-step approach (no DirRec correction) on
error, then to a naive last-MoM repeat.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ---------- constants ----------
_Z80 = 1.2816               # one-sided z for 80% interval
_RESID_FLOOR = 0.10         # don't let intervals collapse on tight fits
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_MIN_TRAIN_ROWS = 36        # minimum rows to bother training a horizon
_OOF_FOLDS = 4              # TimeSeriesSplit folds for OOF previous-horizon preds


_RIDGE_ALPHAS = np.logspace(-3, 3, 19)
_XGB_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    subsample=0.85,
    colsample_bytree=0.85,
    min_child_weight=3,
    reg_lambda=1.0,
    objective="reg:squarederror",
    n_jobs=1,
    verbosity=0,
    random_state=0,
)


# ---------- helpers ----------

def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    feats = X_full.copy()
    feats = feats.ffill(limit=2)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _last_observed_mom(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())


def _fit_ridge_xgb(X_arr: np.ndarray, y_arr: np.ndarray):
    """Fit Ridge (with scaling + TS-CV alpha) and XGB on (X, y).

    Returns dict with: scaler, ridge, xgb, ridge_resid, xgb_resid.
    xgb may be None if xgboost is unavailable.
    """
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    scaler = StandardScaler().fit(X_arr)
    Xs = scaler.transform(X_arr)
    n_splits = min(5, max(2, len(y_arr) // 60))
    try:
        tscv = TimeSeriesSplit(n_splits=n_splits)
        ridge = RidgeCV(alphas=_RIDGE_ALPHAS, cv=tscv).fit(Xs, y_arr)
    except Exception:
        ridge = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xs, y_arr)
    ridge_resid = y_arr - ridge.predict(Xs)

    xgb = None
    xgb_resid = None
    try:
        from xgboost import XGBRegressor

        xgb = XGBRegressor(**_XGB_PARAMS).fit(X_arr, y_arr)
        xgb_resid = y_arr - xgb.predict(X_arr)
    except Exception:
        xgb = None
        xgb_resid = None

    return {
        "scaler": scaler,
        "ridge": ridge,
        "xgb": xgb,
        "ridge_resid": ridge_resid,
        "xgb_resid": xgb_resid,
    }


def _ensemble_predict(bundle: dict, x_live: np.ndarray) -> tuple[float, float]:
    """50/50 Ridge+XGB prediction + blended residual std."""
    scaler = bundle["scaler"]
    ridge = bundle["ridge"]
    xgb = bundle["xgb"]
    ridge_resid = bundle["ridge_resid"]
    xgb_resid = bundle["xgb_resid"]

    x_live_s = scaler.transform(x_live)
    ridge_pred = float(ridge.predict(x_live_s)[0])

    if xgb is not None and xgb_resid is not None:
        xgb_pred = float(xgb.predict(x_live)[0])
        yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
        resid = 0.5 * ridge_resid + 0.5 * xgb_resid
    else:
        yhat = ridge_pred
        resid = ridge_resid

    std = float(np.std(resid))
    std = max(std, _RESID_FLOOR)
    return yhat, std


def _oof_horizon_predictions(
    X_arr: np.ndarray, y_arr: np.ndarray, n_folds: int = _OOF_FOLDS
) -> np.ndarray:
    """Generate OOF predictions for a horizon-h target via TimeSeriesSplit.

    Returns an array of length len(y_arr); rows that were never in any
    validation fold are NaN. Uses 50/50 Ridge+XGB ensemble.
    """
    from sklearn.linear_model import RidgeCV
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import TimeSeriesSplit

    n = len(y_arr)
    oof = np.full(n, np.nan)

    if n < 36:
        return oof

    have_xgb = True
    try:
        from xgboost import XGBRegressor  # noqa: F401
    except Exception:
        have_xgb = False

    n_splits = min(n_folds, max(2, n // 30))
    tscv = TimeSeriesSplit(n_splits=n_splits)

    for tr_idx, va_idx in tscv.split(X_arr):
        if len(tr_idx) < 24:
            continue
        Xtr = X_arr[tr_idx]
        ytr = y_arr[tr_idx]
        Xva = X_arr[va_idx]

        # Ridge
        ridge_va = None
        try:
            sc = StandardScaler().fit(Xtr)
            Xtr_s = sc.transform(Xtr)
            Xva_s = sc.transform(Xva)
            inner_n = min(3, max(2, len(tr_idx) // 60))
            try:
                rcv = RidgeCV(
                    alphas=_RIDGE_ALPHAS,
                    cv=TimeSeriesSplit(n_splits=inner_n),
                ).fit(Xtr_s, ytr)
            except Exception:
                rcv = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xtr_s, ytr)
            ridge_va = rcv.predict(Xva_s)
        except Exception:
            ridge_va = None

        # XGB
        xgb_va = None
        if have_xgb:
            try:
                from xgboost import XGBRegressor

                xm = XGBRegressor(**_XGB_PARAMS).fit(Xtr, ytr)
                xgb_va = xm.predict(Xva)
            except Exception:
                xgb_va = None

        if ridge_va is not None and xgb_va is not None:
            oof[va_idx] = 0.5 * ridge_va + 0.5 * xgb_va
        elif ridge_va is not None:
            oof[va_idx] = ridge_va
        elif xgb_va is not None:
            oof[va_idx] = xgb_va

    return oof


# ---------- the strategy ----------


class DirRecStrategy(ForecastStrategy):
    """DirRec: per-horizon model takes earlier horizons' predictions as features."""

    name = "agent_i_dirrec"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._dirrec(panel, horizon)
        except Exception:
            try:
                return self._direct_only(panel, horizon)
            except Exception:
                return self._naive(panel, horizon)

    # ------------------ main DirRec path ------------------

    def _dirrec(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = build_features(panel)
        y_full = build_target(panel)

        if X_full.empty or y_full.dropna().empty:
            raise RuntimeError("Empty features/target.")

        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        # State accumulators across horizons:
        # `oof_history[h]` is an OOF-predicted-MoM(T+h) series indexed by T.
        # `live_history[h]` is the live forecast for h that we'll feed
        # into models at horizons > h.
        oof_history: dict[int, pd.Series] = {}
        live_history: dict[int, float] = {}

        for h in range(1, horizon + 1):
            try:
                yhat, resid_std, oof_series = self._predict_one_horizon(
                    X_full=X_full,
                    y_full=y_full,
                    h=h,
                    live_row=live_row,
                    oof_history=oof_history,
                    live_history=live_history,
                )
            except Exception:
                yhat = _last_observed_mom(y_full)
                resid_std = max(_empirical_mom_std(y_full), 0.15)
                oof_series = None

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * max(resid_std, _RESID_FLOOR)
            means[h - 1] = yhat
            los[h - 1] = yhat - spread
            his[h - 1] = yhat + spread

            # Stash this horizon's outputs for later horizons to use.
            live_history[h] = yhat
            if oof_series is not None:
                oof_history[h] = oof_series

        return means, los, his

    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
        oof_history: dict[int, pd.Series],
        live_history: dict[int, float],
    ) -> tuple[float, float, pd.Series | None]:
        """Train horizon-h model on enriched features (base X + earlier-horizon
        OOF preds), predict using the live X row + live_history[h-1..1]
        as the extra features. Also generate an OOF prediction series for
        this horizon to feed downstream horizons."""

        # Build target for horizon h: y at time T+h, indexed by T.
        y_target = y_full.shift(-h).rename("y_target")

        # Base supervised pair on plain features.
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            yhat = _last_observed_mom(y_full)
            return yhat, max(_empirical_mom_std(y_full), 0.15), None

        # Enrich features with earlier-horizon OOF preds.
        # For each earlier horizon k < h, we add `oof_history[k]` (indexed by T)
        # as a new column. Rows where any of these are NaN get dropped.
        extra_cols: list[str] = []
        if h > 1:
            df_enriched = df.copy()
            for k in range(1, h):
                if k not in oof_history:
                    # Earlier horizon failed to produce OOF preds; can't enrich.
                    # Fall back to plain direct for this horizon.
                    return self._direct_one_horizon(X_full, y_full, h, live_row)
                col_name = f"prev_h{k}_oof"
                df_enriched[col_name] = oof_history[k]
                extra_cols.append(col_name)
            df_enriched = df_enriched.dropna()
            if len(df_enriched) < _MIN_TRAIN_ROWS:
                # Not enough overlap with OOF history; fall back to direct.
                return self._direct_one_horizon(X_full, y_full, h, live_row)
            df = df_enriched

        feature_cols = [c for c in df.columns if c != "y_target"]
        X_arr = df[feature_cols].values.astype(float)
        y_arr = df["y_target"].values.astype(float)

        # Live feature vector for inference: base live row + live_history.
        # Build it column-by-column to make sure the order matches feature_cols.
        live_vec: list[float] = []
        base_cols = [c for c in feature_cols if c not in extra_cols]
        for c in feature_cols:
            if c in extra_cols:
                # parse k from "prev_h{k}_oof"
                try:
                    k = int(c.replace("prev_h", "").replace("_oof", ""))
                except Exception:
                    k = 0
                live_vec.append(float(live_history.get(k, 0.0)))
            else:
                live_vec.append(float(live_row[c]))
        x_live = np.array(live_vec, dtype=float).reshape(1, -1)

        # Fit + predict.
        bundle = _fit_ridge_xgb(X_arr, y_arr)
        yhat, std = _ensemble_predict(bundle, x_live)

        # Generate OOF predictions for THIS horizon, to feed downstream
        # horizons. Reindex to T-domain Series so it lines up with future
        # `df.join(...)` calls. We need a Series indexed by `df.index`.
        try:
            oof_arr = _oof_horizon_predictions(X_arr, y_arr, n_folds=_OOF_FOLDS)
            oof_series = pd.Series(oof_arr, index=df.index)
        except Exception:
            oof_series = None

        return yhat, std, oof_series

    # ------------------ fallback: plain direct (no DirRec) ------------------

    def _direct_only(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """If anything in the DirRec path fails, this is the backup: plain
        direct multi-step (no enrichment), 50/50 Ridge+XGB ensemble.
        """
        X_full = build_features(panel)
        y_full = build_target(panel)
        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, std = self._direct_one_horizon(X_full, y_full, h, live_row)[:2]
            except Exception:
                yhat = _last_observed_mom(y_full)
                std = max(_empirical_mom_std(y_full), 0.15)

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            spread = _Z80 * max(std, _RESID_FLOOR)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    def _direct_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float, None]:
        """Standard direct (X_T -> y_{T+h}) Ridge+XGB ensemble. Returns
        (yhat, std, None) — None for the OOF series because we don't
        compute it on the fallback path."""
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            return _last_observed_mom(y_full), max(_empirical_mom_std(y_full), 0.15), None

        feature_cols = [c for c in df.columns if c != "y_target"]
        X_arr = df[feature_cols].values.astype(float)
        y_arr = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        bundle = _fit_ridge_xgb(X_arr, y_arr)
        yhat, std = _ensemble_predict(bundle, x_live)
        return yhat, std, None

    # ------------------ last-resort naive fallback ------------------

    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = _last_observed_mom(y)
            sd = max(_empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
