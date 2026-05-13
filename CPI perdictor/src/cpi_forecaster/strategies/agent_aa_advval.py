"""Agent AA — Adversarial validation reweighting.

Idea: train a binary classifier to distinguish "old" training observations
(>3 years before the most-recent training row) from "recent" ones (within
the last 36 months). Out-of-fold "recent" probabilities then become sample
weights for the regression. Old-but-recent-looking obs (e.g. earlier
inflationary episodes structurally similar to today) get up-weighted; old
old-looking obs get a 0.1 floor so they aren't dropped entirely.

Why this beats agent_f's exponential decay: the decay is purely calendar-
based — it can't tell that, say, 2008 looks more like today than 2015 does.
Adversarial validation lets the *features* decide which historical regimes
are most representative of the current regime.

Direct multi-step (one regressor per horizon h) avoids recursive error
compounding on the recursive lag-roll. We blend Ridge + XGBoost 50/50 and
build 80% bands from in-sample residual std.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_supervised, build_target


# 36 months ≈ "recent regime" window for the adversarial validation label.
RECENT_WINDOW_MONTHS = 36

# Floor on the adversarial-derived sample weight so old-looking obs still
# contribute to the fit. Without a floor, weights collapse to ~0 and the
# effective training set shrinks dramatically.
WEIGHT_FLOOR = 0.1


def _persistence_forecast(panel: pd.DataFrame, horizon: int):
    """Last observed MoM repeated. Final fallback if everything else fails."""
    try:
        last = float(build_target(panel).dropna().iloc[-1])
    except Exception:
        last = 0.20
    m = np.array([last] * horizon)
    return m, m - 0.30, m + 0.30


def _last_feature_row(feats: pd.DataFrame) -> pd.Series:
    f = feats.copy().ffill(limit=2).dropna(how="any")
    if f.empty:
        raise RuntimeError("No usable feature row.")
    return f.iloc[-1]


def _adv_val_weights(X: pd.DataFrame, is_recent: np.ndarray) -> np.ndarray:
    """Train a TimeSeriesSplit-OOF XGBClassifier on (X, is_recent), return
    out-of-fold P(recent) for every row, floored at WEIGHT_FLOOR.

    Falls back to a plain calendar-based weight if XGB isn't available.
    """
    n = len(X)
    # If the label is degenerate (all 0 or all 1), the classifier is
    # uninformative — fall back to uniform weights.
    if is_recent.sum() == 0 or is_recent.sum() == n:
        return np.ones(n, dtype=float)

    try:
        import xgboost as xgb
        from sklearn.model_selection import TimeSeriesSplit
    except Exception:
        # Fallback: just use the binary label itself, floored.
        w = np.where(is_recent == 1, 1.0, WEIGHT_FLOOR)
        return w

    # Pick a split count that gives each fold a non-trivial validation slice
    # but doesn't require more rows than we have. 5 is the standard default.
    n_splits = max(2, min(5, n // 24))
    oof = np.full(n, np.nan, dtype=float)
    try:
        tss = TimeSeriesSplit(n_splits=n_splits)
        Xv = X.values
        for tr, va in tss.split(Xv):
            y_tr = is_recent[tr]
            # Skip folds where the training slice is single-class — XGB
            # raises on degenerate targets.
            if y_tr.sum() == 0 or y_tr.sum() == len(y_tr):
                # Default the predictions to the prior probability so we
                # don't leave NaNs. This rarely happens past the first fold.
                oof[va] = float(is_recent.mean())
                continue
            clf = xgb.XGBClassifier(
                n_estimators=200,
                max_depth=3,
                learning_rate=0.05,
                subsample=0.85,
                colsample_bytree=0.85,
                reg_lambda=1.0,
                random_state=42,
                n_jobs=2,
                verbosity=0,
                eval_metric="logloss",
            )
            clf.fit(Xv[tr], y_tr)
            proba = clf.predict_proba(Xv[va])[:, 1]
            oof[va] = proba
        # Rows before the first validation fold are still NaN — fill with
        # the prior so they don't get dropped.
        if np.isnan(oof).any():
            prior = float(is_recent.mean())
            oof = np.where(np.isnan(oof), prior, oof)
    except Exception:
        # Any classifier failure → calendar-based fallback weight.
        return np.where(is_recent == 1, 1.0, WEIGHT_FLOOR)

    w = np.maximum(WEIGHT_FLOOR, oof)
    # Normalize to mean 1 — preserves effective sample size and stabilizes
    # ridge alpha selection.
    if w.mean() > 0:
        w = w * (len(w) / w.sum())
    return w


class AdversarialValidationStrategy(ForecastStrategy):
    name = "agent_aa_advval"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._run(panel, horizon)
        except Exception:
            return _persistence_forecast(panel, horizon)

    # ------------------------------------------------------------------
    def _run(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # 1) Build the supervised matrix and timestamp index.
        X_full, y_full = build_supervised(panel)
        if len(X_full) < 60:
            return _persistence_forecast(panel, horizon)

        # 2) is_recent label: 1 if obs date is within the last 36 months
        #    of the latest training row, else 0.
        idx = X_full.index
        cutoff = idx.max() - pd.DateOffset(months=RECENT_WINDOW_MONTHS)
        is_recent = (idx > cutoff).astype(int).to_numpy()

        # 3) OOF "P(recent)" → sample weights (floor 0.1).
        sample_weight_full = _adv_val_weights(X_full, is_recent)

        # 4) Direct multi-step: one regressor per horizon h. y_h is y shifted
        #    by -(h-1) so X[t] is paired with y[t+h-1]. Drops the last h-1
        #    rows that have no future target.
        feature_cols = list(X_full.columns)
        live_feats = build_features(panel)
        feat_row = _last_feature_row(live_feats)
        x_pred = np.array(
            [float(feat_row.get(c, 0.0)) for c in feature_cols]
        ).reshape(1, -1)

        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        try:
            import xgboost as xgb
            xgb_available = True
        except Exception:
            xgb_available = False

        means: list[float] = []
        all_resid: list[np.ndarray] = []

        for h in range(1, horizon + 1):
            # Pair X[t] with y[t + (h-1)].
            shift = h - 1
            if shift > 0:
                y_h = y_full.shift(-shift)
            else:
                y_h = y_full
            mask = ~y_h.isna().values
            if mask.sum() < 36:
                # Not enough paired rows — fall back to last known MoM.
                last = float(y_full.dropna().iloc[-1])
                means.append(last)
                all_resid.append(np.array([0.3]))
                continue
            X_h = X_full.values[mask]
            y_h_vals = y_h.values[mask]
            w_h = sample_weight_full[mask]

            # 4a) Ridge with weights, alpha picked by weighted in-sample MSE.
            scaler = StandardScaler().fit(X_h)
            Xs_h = scaler.transform(X_h)
            best_ridge = None
            best_loss = np.inf
            for alpha in (0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0):
                try:
                    m = Ridge(alpha=alpha).fit(Xs_h, y_h_vals, sample_weight=w_h)
                    pred = m.predict(Xs_h)
                    loss = float(np.average((y_h_vals - pred) ** 2, weights=w_h))
                    if loss < best_loss:
                        best_loss = loss
                        best_ridge = m
                except Exception:
                    continue
            if best_ridge is None:
                last = float(y_full.dropna().iloc[-1])
                means.append(last)
                all_resid.append(np.array([0.3]))
                continue
            ridge_yhat_pred = float(best_ridge.predict(scaler.transform(x_pred))[0])
            ridge_resid = y_h_vals - best_ridge.predict(Xs_h)

            # 4b) XGBoost with the same sample weights.
            xgb_yhat_pred = ridge_yhat_pred
            xgb_resid = ridge_resid
            if xgb_available:
                try:
                    xgb_model = xgb.XGBRegressor(
                        n_estimators=350,
                        max_depth=3,
                        learning_rate=0.03,
                        subsample=0.85,
                        colsample_bytree=0.85,
                        reg_lambda=1.0,
                        random_state=42,
                        n_jobs=2,
                        verbosity=0,
                    )
                    xgb_model.fit(X_h, y_h_vals, sample_weight=w_h)
                    xgb_yhat_pred = float(xgb_model.predict(x_pred)[0])
                    xgb_resid = y_h_vals - xgb_model.predict(X_h)
                except Exception:
                    pass

            # 5) 50/50 blend.
            yhat = 0.5 * ridge_yhat_pred + 0.5 * xgb_yhat_pred
            blended_resid = 0.5 * ridge_resid + 0.5 * xgb_resid
            means.append(yhat)
            all_resid.append(blended_resid)

        means_arr = np.array(means, dtype=float)

        # 6) 80% bands: per-horizon weighted residual std (each direct model
        #    has its own residual distribution, so no sqrt(h) scaling needed).
        z = 1.2816  # 80% one-sided
        spreads: list[float] = []
        for h_idx, resid in enumerate(all_resid):
            if resid.size == 0:
                spreads.append(0.3)
                continue
            # Use the same sample weights when computing the band so it
            # reflects the recent regime.
            shift = h_idx
            if shift > 0:
                y_h = y_full.shift(-shift)
            else:
                y_h = y_full
            mask = ~y_h.isna().values
            w_h = sample_weight_full[mask]
            if w_h.size != resid.size:
                # Defensive: shape mismatch on fallback row → unweighted std.
                std = float(np.sqrt(np.mean(resid ** 2) + 1e-8))
            else:
                var = float(np.average(resid ** 2, weights=w_h))
                std = float(np.sqrt(max(var, 1e-8)))
            spreads.append(z * std)
        spread_arr = np.array(spreads, dtype=float)
        return means_arr, means_arr - spread_arr, means_arr + spread_arr
