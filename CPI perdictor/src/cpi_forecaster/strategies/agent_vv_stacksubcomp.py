"""Agent VV — stacked subcomponent forecasts.

A different angle on subcomponent forecasting than `hierarchical.py`. The
hierarchical strategy forecast Food / Energy / Core separately and then
aggregated them with FIXED BLS-derived weights — that flopped, in part
because the BLS relative-importance weights are calibrated for level
aggregation, not for combining noisy MoM forecasts whose error structure
is very different across components.

Here we LEARN the aggregation. For each horizon h:

  1. Build four independent base predictors of headline MoM:
       a. Food MoM model — Ridge on macro features (food drivers).
       b. Energy MoM model — Ridge on oil/gas/USD drivers.
       c. Core MoM model — Ridge on wages/shelter/MICH drivers.
       d. Headline MoM model — standard Ridge on the full feature panel.
     Each model targets HEADLINE MoM directly (so the meta sees four
     competing direct forecasts of the same quantity, not three
     subcomponent forecasts that need re-weighting).
  2. Use TimeSeriesSplit (3 folds) to generate out-of-fold predictions of
     all four base models. This gives a clean (n x 4) OOF matrix where
     no row was used to train its own base prediction.
  3. Train a Ridge meta-learner on the OOF matrix vs actual headline MoM
     at horizon h. The meta-learner learns the optimal linear combination
     for that horizon — short horizons weight headline + core more, long
     horizons may lean on energy or food given their different error
     decay patterns.
  4. At inference: refit base models on FULL data, predict each, push the
     four predictions through the meta to get the final headline forecast.
  5. 80% bands from meta's residual std (on the OOF stack) times the
     normal z-quantile. This captures the true post-stacking variance,
     which is materially smaller than any individual base model's std.

Falls back gracefully — subcomponents missing, fits fail, etc. — to a
plain Ridge on headline, then to last-observed MoM.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import FEATURES, TARGET


warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_CORE_ID = "CPILFESL"

_RIDGE_ALPHAS = np.logspace(-3, 3, 13)
_META_ALPHAS = np.logspace(-4, 2, 13)
_Z80 = 1.2816
_RESID_FLOOR = 0.10
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_MIN_TRAIN_ROWS = 36
_N_META_FOLDS = 3

# Component-specific drivers (chosen for economic relevance — same shape
# as hierarchical.py but expanded slightly with the round-5 series so
# the base models have richer, modern feature sets).
_FOOD_DRIVERS = (
    "PPIACO",
    "PPIFIS",
    "DCOILWTICO",
    "CES0500000003",
    "PPIIDC",
    "RSAFS",
)
_ENERGY_DRIVERS = (
    "DCOILWTICO",
    "DCOILBRENTEU",
    "GASREGW",
    "GASDESW",
    "DTWEXBGS",
    "INDPRO",
)
_CORE_DRIVERS = (
    "CES0500000003",
    "CSUSHPISA",
    "CUSR0000SAH1",
    "MICH",
    "M2SL",
    "UNRATE",
    "DGS10",
    "FEDFUNDS",
    "T5YIE",
    "MEDCPIM158SFRBCLE",
    "STICKCPIM157SFRBATL",
    "PCEPILFE",
)


# ---------------------------------------------------------------------------
# Helpers — feature engineering
# ---------------------------------------------------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _build_subcomponent_features(
    panel: pd.DataFrame, component_id: str, driver_ids: tuple[str, ...]
) -> pd.DataFrame:
    """Lagged feature matrix for a base model focused on one subcomponent.

    Uses the SUBCOMPONENT's own MoM lags as autoregressive context plus
    the listed drivers. Calendar features included since each component
    has its own residual seasonality. All columns shifted so row T uses
    only data available by end of T-1.
    """
    rows: dict[str, pd.Series] = {}

    # Headline MoM lags too — every base model predicts headline, so it
    # helps to see headline's own recent history.
    if TARGET.fred_id in panel.columns:
        head = panel[TARGET.fred_id]
        rows["head_mom_lag1"] = _log_mom(head).shift(1)
        rows["head_mom_lag2"] = _log_mom(head).shift(2)
        rows["head_mom_lag3"] = _log_mom(head).shift(3)
        rows["head_yoy_lag1"] = _yoy(head).shift(1)

    # Subcomponent autoregressive context.
    if component_id in panel.columns:
        comp = panel[component_id]
        rows[f"{component_id}_mom_lag1"] = _log_mom(comp).shift(1)
        rows[f"{component_id}_mom_lag2"] = _log_mom(comp).shift(2)
        rows[f"{component_id}_mom_lag3"] = _log_mom(comp).shift(3)
        rows[f"{component_id}_yoy_lag1"] = _yoy(comp).shift(1)

    for did in driver_ids:
        if did not in panel.columns:
            continue
        d = panel[did]
        rows[f"{did}_mom_lag1"] = _mom(d).shift(1)
        rows[f"{did}_3mo_lag1"] = ((d / d.shift(3) - 1.0) * 100.0).shift(1)
        rows[f"{did}_yoy_lag1"] = _yoy(d).shift(1)

    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx, name="month_sin"
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx, name="month_cos"
    )

    return pd.concat(rows, axis=1)


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class StackedSubcomponentsStrategy(ForecastStrategy):
    """Four base headline-MoM models (Food / Energy / Core / Headline view)
    combined per horizon by a Ridge meta-learner trained on OOF predictions."""

    name = "agent_vv_stacksubcomp"

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._stacked(panel, horizon)
        except Exception:
            return self._fallback_headline(panel, horizon)

    # ------------------------------------------------------------------
    # Main stacked path
    # ------------------------------------------------------------------
    def _stacked(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Sanity check: subcomponents and headline must exist.
        for cid in (_FOOD_ID, _ENERGY_ID, _CORE_ID, TARGET.fred_id):
            if cid not in panel.columns:
                return self._fallback_headline(panel, horizon)

        # Build the four independent feature matrices. All four predict
        # the SAME target (headline MoM) — they just see different views
        # of the panel.
        food_X = _build_subcomponent_features(panel, _FOOD_ID, _FOOD_DRIVERS)
        ener_X = _build_subcomponent_features(panel, _ENERGY_ID, _ENERGY_DRIVERS)
        core_X = _build_subcomponent_features(panel, _CORE_ID, _CORE_DRIVERS)
        head_X = build_features(panel)
        head_y = build_target(panel)  # headline MoM target

        # Latest aligned feature row for each view (for inference).
        food_live = self._latest_feature_row(food_X)
        ener_live = self._latest_feature_row(ener_X)
        core_live = self._latest_feature_row(core_X)
        head_live = self._latest_feature_row(head_X)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, sd = self._stack_one_horizon(
                    food_X, ener_X, core_X, head_X, head_y,
                    food_live, ener_live, core_live, head_live,
                    h,
                )
            except Exception:
                yhat, sd = self._headline_naive_one(panel)
            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
            sd = max(sd, _RESID_FLOOR)
            spread = _Z80 * sd
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # Per-horizon stacking
    # ------------------------------------------------------------------
    @staticmethod
    def _stack_one_horizon(
        food_X: pd.DataFrame,
        ener_X: pd.DataFrame,
        core_X: pd.DataFrame,
        head_X: pd.DataFrame,
        head_y: pd.Series,
        food_live: pd.Series,
        ener_live: pd.Series,
        core_live: pd.Series,
        head_live: pd.Series,
        h: int,
    ) -> tuple[float, float]:
        """OOF-stack the four base models and return (mean, resid_std).

        Targets are aligned to the same headline-MoM y shifted by -h, so
        the meta-learner sees four competing direct forecasts of the same
        future quantity. The meta is trained on out-of-fold predictions
        only — the four base models are not trained on the rows whose
        OOF prediction they generate, which is what makes stacking work.
        """
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        target = head_y.shift(-h).rename("y_target")

        # Inner-join everything to a common index where ALL four feature
        # views and the future target are available. Using the same index
        # keeps the meta-learner's input matrix square per row.
        joined = (
            food_X.add_prefix("F_")
            .join(ener_X.add_prefix("E_"), how="inner")
            .join(core_X.add_prefix("C_"), how="inner")
            .join(head_X.add_prefix("H_"), how="inner")
            .join(target, how="inner")
            .dropna()
        )
        if len(joined) < _MIN_TRAIN_ROWS:
            # Not enough data — last-observed headline MoM persistence.
            last_y = head_y.dropna()
            yhat = float(last_y.iloc[-1]) if not last_y.empty else 0.0
            sd = float(last_y.tail(60).std()) if len(last_y) >= 12 else 0.30
            return yhat, max(sd, _RESID_FLOOR)

        food_cols = [c for c in joined.columns if c.startswith("F_")]
        ener_cols = [c for c in joined.columns if c.startswith("E_")]
        core_cols = [c for c in joined.columns if c.startswith("C_")]
        head_cols = [c for c in joined.columns if c.startswith("H_")]

        Xf = joined[food_cols].values.astype(float)
        Xe = joined[ener_cols].values.astype(float)
        Xc = joined[core_cols].values.astype(float)
        Xh = joined[head_cols].values.astype(float)
        y = joined["y_target"].values.astype(float)

        n = len(joined)
        oof = np.zeros((n, 4), dtype=float)

        # Out-of-fold predictions across TimeSeriesSplit folds.
        n_splits = max(2, min(_N_META_FOLDS, n // 24))
        tscv = TimeSeriesSplit(n_splits=n_splits)
        any_oof = False
        for tr_idx, te_idx in tscv.split(Xf):
            if len(tr_idx) < 12 or len(te_idx) < 1:
                continue
            for col, X in enumerate((Xf, Xe, Xc, Xh)):
                try:
                    sc = StandardScaler().fit(X[tr_idx])
                    Xtr = sc.transform(X[tr_idx])
                    Xte = sc.transform(X[te_idx])
                    inner_splits = max(2, min(4, len(tr_idx) // 60))
                    inner_cv = TimeSeriesSplit(n_splits=inner_splits)
                    try:
                        m = RidgeCV(alphas=_RIDGE_ALPHAS, cv=inner_cv).fit(Xtr, y[tr_idx])
                    except Exception:
                        m = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xtr, y[tr_idx])
                    oof[te_idx, col] = m.predict(Xte)
                except Exception:
                    # Leave that base's OOF entry at 0 — meta will down-weight it.
                    oof[te_idx, col] = 0.0
            any_oof = True

        if not any_oof:
            # No usable splits — fall back to naive at this horizon.
            last_y = head_y.dropna()
            yhat = float(last_y.iloc[-1]) if not last_y.empty else 0.0
            sd = float(last_y.tail(60).std()) if len(last_y) >= 12 else 0.30
            return yhat, max(sd, _RESID_FLOOR)

        # Restrict the meta-train rows to those that actually got an OOF
        # prediction (any row with all-zero across the 4 columns is from
        # before the first fold's test window).
        oof_mask = np.any(oof != 0.0, axis=1)
        if oof_mask.sum() < 12:
            last_y = head_y.dropna()
            yhat = float(last_y.iloc[-1]) if not last_y.empty else 0.0
            sd = float(last_y.tail(60).std()) if len(last_y) >= 12 else 0.30
            return yhat, max(sd, _RESID_FLOOR)

        Z = oof[oof_mask]
        yz = y[oof_mask]

        # Train meta-learner — Ridge on the (n_oof x 4) OOF matrix.
        try:
            inner_splits = max(2, min(4, len(Z) // 30))
            inner_cv = TimeSeriesSplit(n_splits=inner_splits)
            try:
                meta = RidgeCV(alphas=_META_ALPHAS, cv=inner_cv).fit(Z, yz)
            except Exception:
                meta = RidgeCV(alphas=_META_ALPHAS).fit(Z, yz)
        except Exception:
            # Worst case: equal-weight meta.
            class _EqualWeight:
                def predict(self, X):
                    return X.mean(axis=1)
            meta = _EqualWeight()

        # Refit each base on the FULL training set (no held-out rows now)
        # and produce a single inference prediction at the cut date.
        live_preds = np.zeros(4, dtype=float)
        for col, (X, x_live_row, source_cols) in enumerate(
            (
                (Xf, food_live, food_cols),
                (Xe, ener_live, ener_cols),
                (Xc, core_live, core_cols),
                (Xh, head_live, head_cols),
            )
        ):
            try:
                sc = StandardScaler().fit(X)
                Xs = sc.transform(X)
                inner_splits = max(2, min(5, len(X) // 60))
                inner_cv = TimeSeriesSplit(n_splits=inner_splits)
                try:
                    base = RidgeCV(alphas=_RIDGE_ALPHAS, cv=inner_cv).fit(Xs, y)
                except Exception:
                    base = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xs, y)
                # The live row has the prefixed names from `joined`; we
                # need the unprefixed values via the original live_row
                # series. Strip the prefix to look up the bare column name.
                bare = [c.split("_", 1)[1] for c in source_cols]
                # Filter to columns present in the live row (defensive).
                vals = []
                for cname in bare:
                    if cname in x_live_row.index:
                        vals.append(float(x_live_row[cname]))
                    else:
                        vals.append(0.0)
                x_live_arr = np.asarray(vals, dtype=float).reshape(1, -1)
                x_live_s = sc.transform(x_live_arr)
                live_preds[col] = float(base.predict(x_live_s)[0])
            except Exception:
                live_preds[col] = 0.0

        yhat = float(meta.predict(live_preds.reshape(1, -1))[0])
        # Residual std on the meta's OOF fit — captures true post-stacking
        # uncertainty (smaller than any base alone if meta is doing work).
        try:
            resid = yz - meta.predict(Z)
            sd = float(np.std(resid))
        except Exception:
            sd = 0.25
        return yhat, max(sd, _RESID_FLOOR)

    # ------------------------------------------------------------------
    # Latest-feature-row helper
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    # ------------------------------------------------------------------
    # Naive helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _headline_naive_one(panel: pd.DataFrame) -> tuple[float, float]:
        try:
            s = _log_mom(panel[TARGET.fred_id]).dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        except Exception:
            last, sd = 0.0, 0.30
        return last, max(sd, _RESID_FLOOR)

    # ------------------------------------------------------------------
    # Whole-strategy fallback: Ridge on headline only
    # ------------------------------------------------------------------
    def _fallback_headline(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            from sklearn.linear_model import RidgeCV
            from sklearn.preprocessing import StandardScaler
            from sklearn.model_selection import TimeSeriesSplit

            X_full = build_features(panel)
            y_full = build_target(panel)
            live_row = self._latest_feature_row(X_full)

            means = np.empty(horizon, dtype=float)
            los = np.empty(horizon, dtype=float)
            his = np.empty(horizon, dtype=float)
            for i, h in enumerate(range(1, horizon + 1)):
                try:
                    y_target = y_full.shift(-h).rename("y_target")
                    df = X_full.join(y_target, how="inner").dropna()
                    if len(df) < _MIN_TRAIN_ROWS:
                        yhat, sd = self._headline_naive_one(panel)
                    else:
                        feature_cols = [c for c in df.columns if c != "y_target"]
                        X = df[feature_cols].values.astype(float)
                        y = df["y_target"].values.astype(float)
                        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)
                        sc = StandardScaler().fit(X)
                        Xs = sc.transform(X)
                        x_live_s = sc.transform(x_live)
                        n_splits = min(5, max(2, len(df) // 60))
                        try:
                            tscv = TimeSeriesSplit(n_splits=n_splits)
                            ridge = RidgeCV(alphas=_RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
                        except Exception:
                            ridge = RidgeCV(alphas=_RIDGE_ALPHAS).fit(Xs, y)
                        yhat = float(ridge.predict(x_live_s)[0])
                        resid = y - ridge.predict(Xs)
                        sd = max(float(np.std(resid)), _RESID_FLOOR)
                except Exception:
                    yhat, sd = self._headline_naive_one(panel)
                yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
                spread = _Z80 * max(sd, _RESID_FLOOR)
                means[i] = yhat
                los[i] = yhat - spread
                his[i] = yhat + spread
            return means, los, his
        except Exception:
            try:
                y = _log_mom(panel[TARGET.fred_id]).dropna()
                last = float(y.iloc[-1]) if not y.empty else 0.0
                sd = float(y.tail(60).std()) if len(y) >= 12 else 0.30
            except Exception:
                last, sd = 0.0, 0.30
            sd = max(sd, 0.15)
            means = np.full(horizon, last, dtype=float)
            spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
            return means, means - spread, means + spread
