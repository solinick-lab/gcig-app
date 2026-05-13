"""Stacked-generalization ensemble (Agent E).

Replaces the inverse-RMSE / equal-weight blend with a learned meta-model.
The pipeline:

  1. Generate out-of-fold (OOF) one-step predictions for SARIMA, Ridge, and
     XGBoost using a small TimeSeriesSplit (3 folds — keep it cheap).
  2. Fit a Ridge meta-learner on the OOF triplets:  y_t ~ [s_t, r_t, x_t].
  3. At inference, refit each base model on the FULL training panel,
     produce horizon-step forecasts, then push every horizon-step's
     base predictions through the meta-Ridge to get the final mean.

If anything goes wrong (small panel, fold failure, etc.) we silently fall
back to an equal-weight average of whatever base models produced output
— and ultimately to the last observed MoM if even that fails. This
strategy MUST NOT raise, per the race contract.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_supervised, build_target
from ..models import RidgeForecaster, SarimaForecaster, XgbForecaster


# Number of TS-CV folds for OOF generation. 3 is a good speed/signal
# trade-off — more folds buys little and refitting SARIMA is the slow bit.
_N_FOLDS = 3
# Minimum training rows we need before we'll even attempt stacking.
_MIN_TRAIN_ROWS = 60
# Validation block size per fold (months). Bigger -> more OOF rows for the
# meta but smaller training panel for the inner base models.
_VAL_BLOCK = 6


def _safe_last_mom(panel: pd.DataFrame) -> float:
    try:
        return float(build_target(panel).dropna().iloc[-1])
    except Exception:
        return 0.0


def _equal_weight_ensemble(
    panel: pd.DataFrame, horizon: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Fallback path — same shape as BaselineEnsembleStrategy."""
    means: list[np.ndarray] = []
    los: list[np.ndarray] = []
    his: list[np.ndarray] = []
    for cls in (SarimaForecaster, RidgeForecaster, XgbForecaster):
        try:
            m, lo, hi = cls().fit(panel).predict(horizon)
        except Exception:
            last = _safe_last_mom(panel)
            m = np.array([last] * horizon, dtype=float)
            lo = m - 0.30
            hi = m + 0.30
        means.append(np.asarray(m, dtype=float))
        los.append(np.asarray(lo, dtype=float))
        his.append(np.asarray(hi, dtype=float))
    return (
        np.mean(means, axis=0),
        np.mean(los, axis=0),
        np.mean(his, axis=0),
    )


def _slice_panel_to(panel: pd.DataFrame, end_ts: pd.Timestamp) -> pd.DataFrame:
    """Return rows of the panel with index <= end_ts. Inclusive."""
    return panel.loc[panel.index <= end_ts]


def _sarima_one_step_predictions(
    train_panel: pd.DataFrame, val_index: pd.DatetimeIndex
) -> np.ndarray:
    """Forecast one MoM% per row in val_index, all from the train_panel
    cut. We use a single forecast call (multi-step on the val block) —
    refitting per step would triple SARIMA cost and barely changes the
    OOF signal. For 3 folds * 6 months that's still plenty of training
    rows for the meta-Ridge."""
    model = SarimaForecaster().fit(train_panel)
    mean, _, _ = model.predict(len(val_index))
    return np.asarray(mean, dtype=float)


class StackedEnsembleStrategy(ForecastStrategy):
    """Ridge meta-learner over SARIMA + Ridge + XGBoost OOF predictions."""

    name = "agent_e_stacking"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            # Hard fallback — race contract says we must not raise.
            try:
                return _equal_weight_ensemble(panel, horizon)
            except Exception:
                last = _safe_last_mom(panel)
                m = np.array([last] * horizon, dtype=float)
                return m, m - 0.30, m + 0.30

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Get the supervised target index — this is the set of months we
        # actually have a clean (X, y) pair for. We'll do TS-CV over THESE
        # rows (so the meta sees the same kind of data the base models see).
        try:
            _X_full, y_full = build_supervised(panel)
        except Exception:
            return _equal_weight_ensemble(panel, horizon)

        if len(y_full) < _MIN_TRAIN_ROWS:
            return _equal_weight_ensemble(panel, horizon)

        # Build the fold layout: validation blocks are the last
        # _N_FOLDS * _VAL_BLOCK rows of y_full, sliced into chunks.
        target_index = y_full.index
        oof_rows = _N_FOLDS * _VAL_BLOCK
        if len(target_index) < oof_rows + 24:
            # Need at least 24 months of training before the first fold.
            return _equal_weight_ensemble(panel, horizon)

        oof_records: list[tuple[float, float, float, float]] = []  # (s, r, x, y)

        # Sequential TS-CV: each fold trains on data up to fold_start - 1
        # and predicts the next _VAL_BLOCK rows.
        first_val_pos = len(target_index) - oof_rows
        for fold_i in range(_N_FOLDS):
            val_start_pos = first_val_pos + fold_i * _VAL_BLOCK
            val_end_pos = val_start_pos + _VAL_BLOCK
            val_idx = target_index[val_start_pos:val_end_pos]
            if len(val_idx) == 0:
                continue
            train_cutoff = target_index[val_start_pos - 1]
            train_panel = _slice_panel_to(panel, train_cutoff)

            # Run the three base models. Anything that fails contributes NaN
            # for this fold and is silently dropped before meta fitting.
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                try:
                    s_pred = _sarima_one_step_predictions(train_panel, val_idx)
                except Exception:
                    s_pred = np.full(len(val_idx), np.nan)
                try:
                    r_pred = self._ridge_val_preds(panel, train_panel, val_idx)
                except Exception:
                    r_pred = np.full(len(val_idx), np.nan)
                try:
                    x_pred = self._xgb_val_preds(panel, train_panel, val_idx)
                except Exception:
                    x_pred = np.full(len(val_idx), np.nan)

            actual = y_full.loc[val_idx].values
            for s, r, x, a in zip(s_pred, r_pred, x_pred, actual):
                if np.isfinite(s) and np.isfinite(r) and np.isfinite(x) and np.isfinite(a):
                    oof_records.append((float(s), float(r), float(x), float(a)))

        # Need enough clean OOF rows to fit the meta. 6+ is a soft
        # threshold — three coefs + intercept = 4 unknowns, plus we
        # want a tiny bit of slack for stability.
        if len(oof_records) < 6:
            return _equal_weight_ensemble(panel, horizon)

        oof_arr = np.asarray(oof_records, dtype=float)
        meta_X = oof_arr[:, :3]
        meta_y = oof_arr[:, 3]

        # Fit the meta-Ridge. Small alpha grid — we don't want it to
        # collapse to constant (alpha too large) or overfit (alpha tiny).
        from sklearn.linear_model import RidgeCV

        # If sample count is too small for CV folds, RidgeCV will fall
        # back to LOOCV, which is fine.
        meta = RidgeCV(alphas=np.logspace(-2, 2, 9)).fit(meta_X, meta_y)
        meta_residuals = meta_y - meta.predict(meta_X)
        meta_resid_std = float(np.std(meta_residuals)) if len(meta_residuals) > 1 else 0.30
        if not np.isfinite(meta_resid_std) or meta_resid_std <= 0:
            meta_resid_std = 0.30

        # Now refit each base model on the FULL panel and grab horizon-step
        # forecasts.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            sarima_mean = self._final_sarima(panel, horizon)
            ridge_mean = self._final_ridge(panel, horizon)
            xgb_mean = self._final_xgb(panel, horizon)

        # If any base model failed to produce valid output, fall back.
        for arr in (sarima_mean, ridge_mean, xgb_mean):
            if arr is None or len(arr) != horizon or not np.all(np.isfinite(arr)):
                return _equal_weight_ensemble(panel, horizon)

        base_stack = np.stack([sarima_mean, ridge_mean, xgb_mean], axis=1)  # (h, 3)
        ensemble_mean = meta.predict(base_stack)

        # Sanity check the ensemble — if it's wildly off (>3pct MoM), the
        # meta probably overfit something silly; revert to equal weight.
        if not np.all(np.isfinite(ensemble_mean)) or np.max(np.abs(ensemble_mean)) > 5.0:
            return _equal_weight_ensemble(panel, horizon)

        # 80% bands: meta residual std * sqrt(h).
        z = 1.2816  # 80% one-sided
        spread = z * meta_resid_std * np.sqrt(np.arange(1, horizon + 1))
        return (
            np.asarray(ensemble_mean, dtype=float),
            np.asarray(ensemble_mean - spread, dtype=float),
            np.asarray(ensemble_mean + spread, dtype=float),
        )

    # ----- per-fold helpers (use the master `panel` for feature lookup) -----

    def _ridge_val_preds(
        self,
        master_panel: pd.DataFrame,
        train_panel: pd.DataFrame,
        val_idx: pd.DatetimeIndex,
    ) -> np.ndarray:
        rf = RidgeForecaster().fit(train_panel)
        feats = build_features(master_panel).ffill(limit=2)
        feature_cols = rf._feature_cols or []
        out: list[float] = []
        for ts in val_idx:
            if ts not in feats.index:
                out.append(np.nan)
                continue
            row = feats.loc[ts]
            if row[feature_cols].isna().any():
                out.append(np.nan)
                continue
            x = row[feature_cols].values.reshape(1, -1)
            xs = rf._scaler.transform(x)  # type: ignore[union-attr]
            out.append(float(rf._model.predict(xs)[0]))  # type: ignore[union-attr]
        return np.asarray(out, dtype=float)

    def _xgb_val_preds(
        self,
        master_panel: pd.DataFrame,
        train_panel: pd.DataFrame,
        val_idx: pd.DatetimeIndex,
    ) -> np.ndarray:
        xf = XgbForecaster().fit(train_panel)
        feats = build_features(master_panel).ffill(limit=2)
        feature_cols = xf._feature_cols or []
        out: list[float] = []
        for ts in val_idx:
            if ts not in feats.index:
                out.append(np.nan)
                continue
            row = feats.loc[ts]
            if row[feature_cols].isna().any():
                out.append(np.nan)
                continue
            x = row[feature_cols].values.reshape(1, -1)
            out.append(float(xf._model.predict(x)[0]))  # type: ignore[union-attr]
        return np.asarray(out, dtype=float)

    # ----- final-fit helpers --------------------------------------------------

    def _final_sarima(self, panel: pd.DataFrame, horizon: int) -> np.ndarray | None:
        try:
            m, _, _ = SarimaForecaster().fit(panel).predict(horizon)
            return np.asarray(m, dtype=float)
        except Exception:
            return None

    def _final_ridge(self, panel: pd.DataFrame, horizon: int) -> np.ndarray | None:
        try:
            m, _, _ = RidgeForecaster().fit(panel).predict(horizon)
            return np.asarray(m, dtype=float)
        except Exception:
            return None

    def _final_xgb(self, panel: pd.DataFrame, horizon: int) -> np.ndarray | None:
        try:
            m, _, _ = XgbForecaster().fit(panel).predict(horizon)
            return np.asarray(m, dtype=float)
        except Exception:
            return None
