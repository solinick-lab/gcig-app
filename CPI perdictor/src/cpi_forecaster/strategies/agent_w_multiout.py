"""MultiOutput joint multi-horizon forecasting (Agent W).

The direct strategy (`agent_b_direct`) trains an independent model per
horizon. That works, but it duplicates work and doesn't share any
representation across horizons. This strategy uses sklearn's
`MultiOutputRegressor` and `RegressorChain` to JOINTLY model all H
horizons:

  - MultiOutputRegressor wraps a base regressor and fits one copy per
    target column. It's effectively the same as the direct approach
    but cleanly batched, which gives identical features to every
    horizon and matches predict shapes.
  - RegressorChain chains them: model for h=1 trains on X, model for
    h=2 trains on [X, yhat_1], model for h=3 trains on [X, yhat_1,
    yhat_2]. This is the sklearn-native flavor of DirRec — later
    horizons get to lean on the explicit short-horizon prediction.

We try four combinations (Multi/Chain × Ridge/XGB), score each with a
quick TimeSeriesSplit CV on the multi-target Y, and ensemble the top
performers. 80% bands come from per-horizon training residual std with
z=1.2816, floored to avoid silly-tight intervals.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class MultiOutputStrategy(ForecastStrategy):
    name = "agent_w_multiout"

    _MAX_H = 3  # we always build a 3-target Y for joint fitting
    _RIDGE_ALPHAS = np.logspace(-3, 3, 13)
    _XGB_PARAMS = dict(
        n_estimators=250,
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
    _Z80 = 1.2816
    _RESID_FLOOR = 0.10

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = build_features(panel)
        y_full = build_target(panel)

        H = max(int(horizon), 1)
        H_train = max(H, self._MAX_H)  # always train on >=3 to share representation

        X_train, Y_train, x_live = self._build_multitarget(X_full, y_full, H_train)
        if X_train is None or len(X_train) < 36:
            return self._fallback(panel, horizon)

        # Build candidates. Each returns (preds shape (H_train,), resid std per h).
        candidates: list[tuple[str, np.ndarray, np.ndarray, float]] = []
        for spec in self._candidate_specs():
            try:
                preds, resid_stds, cv_score = self._fit_candidate(
                    spec, X_train, Y_train, x_live
                )
                candidates.append((spec["name"], preds, resid_stds, cv_score))
            except Exception:
                continue

        if not candidates:
            return self._fallback(panel, horizon)

        # Pick top-2 by CV (lower is better) and ensemble them.
        candidates.sort(key=lambda t: t[3])
        top = candidates[: min(2, len(candidates))]
        weights = np.ones(len(top), dtype=float) / len(top)
        preds_stack = np.stack([c[1] for c in top], axis=0)
        resid_stack = np.stack([c[2] for c in top], axis=0)
        means_full = (weights[:, None] * preds_stack).sum(axis=0)
        resid_full = np.sqrt((weights[:, None] * (resid_stack ** 2)).sum(axis=0))

        means = means_full[:H]
        resid_h = np.maximum(resid_full[:H], self._RESID_FLOOR)
        spread = self._Z80 * resid_h
        return means, means - spread, means + spread

    # ------------------------------------------------------------------
    # candidate construction & evaluation
    # ------------------------------------------------------------------
    def _candidate_specs(self) -> list[dict]:
        specs: list[dict] = [
            {"name": "multi_ridge", "wrap": "multi", "base": "ridge"},
            {"name": "chain_ridge", "wrap": "chain", "base": "ridge"},
            {"name": "multi_xgb", "wrap": "multi", "base": "xgb"},
            {"name": "chain_xgb", "wrap": "chain", "base": "xgb"},
        ]
        return specs

    def _make_base(self, kind: str):
        if kind == "ridge":
            from sklearn.linear_model import Ridge

            # Mid-range alpha; we scale features so this is a sensible default.
            return Ridge(alpha=1.0, random_state=0)
        if kind == "xgb":
            from xgboost import XGBRegressor

            return XGBRegressor(**self._XGB_PARAMS)
        raise ValueError(f"unknown base {kind}")

    def _wrap(self, base, wrap: str):
        from sklearn.multioutput import MultiOutputRegressor, RegressorChain

        if wrap == "multi":
            return MultiOutputRegressor(base)
        if wrap == "chain":
            # order=None keeps natural order h=1, h=2, h=3.
            return RegressorChain(base, order=None)
        raise ValueError(f"unknown wrap {wrap}")

    def _fit_candidate(
        self,
        spec: dict,
        X_train: np.ndarray,
        Y_train: np.ndarray,
        x_live: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, float]:
        from sklearn.preprocessing import StandardScaler

        scale_inputs = spec["base"] == "ridge"
        if scale_inputs:
            scaler = StandardScaler().fit(X_train)
            X_use = scaler.transform(X_train)
            x_live_use = scaler.transform(x_live)
        else:
            X_use = X_train
            x_live_use = x_live

        base = self._make_base(spec["base"])
        model = self._wrap(base, spec["wrap"])
        model.fit(X_use, Y_train)

        preds = np.asarray(model.predict(x_live_use)).reshape(-1)
        in_sample = np.asarray(model.predict(X_use))
        residuals = Y_train - in_sample
        resid_stds = residuals.std(axis=0)

        cv_score = self._cv_score(spec, X_train, Y_train)
        return preds, resid_stds, cv_score

    def _cv_score(self, spec: dict, X: np.ndarray, Y: np.ndarray) -> float:
        """Cheap TimeSeriesSplit RMSE averaged across horizons."""
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.preprocessing import StandardScaler

        n = len(X)
        n_splits = min(4, max(2, n // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
        except Exception:
            return float("inf")

        errs: list[float] = []
        for tr_idx, te_idx in tscv.split(X):
            try:
                X_tr, X_te = X[tr_idx], X[te_idx]
                Y_tr, Y_te = Y[tr_idx], Y[te_idx]
                if spec["base"] == "ridge":
                    sc = StandardScaler().fit(X_tr)
                    X_tr = sc.transform(X_tr)
                    X_te = sc.transform(X_te)
                base = self._make_base(spec["base"])
                model = self._wrap(base, spec["wrap"])
                model.fit(X_tr, Y_tr)
                pred = np.asarray(model.predict(X_te))
                err = float(np.sqrt(np.mean((pred - Y_te) ** 2)))
                if np.isfinite(err):
                    errs.append(err)
            except Exception:
                continue
        if not errs:
            return float("inf")
        return float(np.mean(errs))

    # ------------------------------------------------------------------
    # data prep
    # ------------------------------------------------------------------
    def _build_multitarget(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        H: int,
    ) -> tuple[np.ndarray | None, np.ndarray | None, np.ndarray | None]:
        """Construct (X, Y) where Y has H columns of forward MoM, plus the
        live row for prediction. NaN-drop after stacking targets."""
        targets = {}
        for h in range(1, H + 1):
            targets[f"y_h{h}"] = y_full.shift(-h)
        Y_df = pd.concat(targets, axis=1)

        df = X_full.join(Y_df, how="inner")
        feat_cols = [c for c in X_full.columns]
        target_cols = list(Y_df.columns)
        df_train = df.dropna(subset=feat_cols + target_cols)
        if df_train.empty:
            return None, None, None

        X_train = df_train[feat_cols].values.astype(float)
        Y_train = df_train[target_cols].values.astype(float)

        live_row = self._latest_feature_row(X_full)
        x_live = live_row[feat_cols].values.astype(float).reshape(1, -1)
        return X_train, Y_train, x_live

    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    # ------------------------------------------------------------------
    # fallback
    # ------------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel).dropna()
            last = float(y.iloc[-1]) if not y.empty else 0.0
            sd = float(y.tail(60).std()) if len(y) >= 12 else 0.25
            sd = max(sd, 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
