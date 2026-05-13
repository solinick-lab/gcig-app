"""YoY-direct multi-step forecasting (Agent T).

Every existing strategy predicts MoM (CPI's monthly log-change) and
chains forward to compute YoY. That chaining compounds errors — three
months of small MoM mistakes line up systematically when summed into a
single YoY number, which is what the race grades on.

This strategy flips the orientation. For each horizon h we build a
target that IS the YoY at month T+h:

    target_yoy[T] = (cpi[T+h] / cpi[T+h-12] - 1) * 100

and fit a Ridge + XGBoost ensemble directly against that. No chaining
in the prediction step — one forward pass per horizon delivers a YoY
number. We then INVERT the YoY back into a CPI level using the known
historical denominator (cpi[T+h-12], which sits inside the panel as
long as h<=12) and finally derive the MoM the contract requires:

    pred_cpi[T+h] = (1 + pred_yoy/100) * cpi[T+h-12]
    pred_mom[h]   = (log(pred_cpi[T+h]) - log(prev_cpi)) * 100

For h=1 the "prev_cpi" is the most recent observed CPI level; for
h=2,3 we chain through the predicted levels (still cheap — the heavy
lifting was done in YoY space, this is just an algebraic conversion).

The target is more autocorrelated than MoM (consecutive YoYs share 11
of 12 base months), so the Ridge effective DOF is lower and we lean a
bit more on regularization. Residual std is computed in YoY space and
then translated to MoM space for the 80% bands.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features
from ..fred import TARGET


warnings.filterwarnings("ignore")


class YoYDirectStrategy(ForecastStrategy):
    name = "agent_t_yoydirect"

    # Slightly wider alpha grid than the MoM direct strategy: YoY targets
    # are smoother and benefit from a touch more shrinkage.
    _RIDGE_ALPHAS = np.logspace(-2, 4, 19)
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
    _Z80 = 1.2816  # one-sided z for 80% interval

    # ------------------------------------------------------------------
    # entry point
    # ------------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._fit_and_predict_inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    def _fit_and_predict_inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        cpi = panel[TARGET.fred_id].astype(float).copy()
        cpi = cpi.dropna()
        if len(cpi) < 36:
            return self._fallback(panel, horizon)

        X_full = build_features(panel)
        live_row = self._latest_feature_row(X_full)

        # cpi level "now" = the last observed CPI at the cut date.
        cpi_now = float(cpi.iloc[-1])

        # Per-horizon YoY predictions and their residual stds (YoY space).
        pred_yoy = np.empty(horizon, dtype=float)
        yoy_resid_std = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yoy_hat, sd = self._fit_one_horizon_yoy(X_full, cpi, h, live_row)
            except Exception:
                yoy_hat, sd = self._fallback_yoy(cpi, h)
            pred_yoy[i] = yoy_hat
            yoy_resid_std[i] = sd

        # ----- Convert predicted YoY to predicted CPI level -----
        # For h<=12 the denominator cpi[T+h-12] is observed history. For
        # h>12 it's a previously predicted level — we'd need to recurse
        # through earlier predicted levels. The race usually runs h<=3,
        # but we handle the >12 case defensively.
        pred_cpi = np.empty(horizon, dtype=float)
        for i, h in enumerate(range(1, horizon + 1)):
            denom = self._level_at_offset(cpi, h - 12, pred_cpi)
            pred_cpi[i] = (1.0 + pred_yoy[i] / 100.0) * denom

        # ----- Derive MoM (log %) the harness expects -----
        means = np.empty(horizon, dtype=float)
        for i in range(horizon):
            prev = cpi_now if i == 0 else pred_cpi[i - 1]
            # Guard against pathological non-positive level predictions.
            if prev <= 0 or pred_cpi[i] <= 0:
                means[i] = 0.0
            else:
                means[i] = (np.log(pred_cpi[i]) - np.log(prev)) * 100.0

        # ----- 80% bands: scale YoY residual std into MoM space -----
        # A YoY error at horizon h propagates almost 1:1 into the MoM at h
        # (because the MoM at h is a difference of two log-levels, and the
        # YoY at h-1 is fixed once we condition on it). Empirically, MoM
        # residuals are larger than the YoY → MoM jacobian alone implies,
        # so we floor the std at the empirical MoM scale.
        emp_mom_sd = self._empirical_mom_std(cpi)
        spread = np.empty(horizon, dtype=float)
        for i in range(horizon):
            # YoY residual std is approx the std of log(pred_cpi[i]) once
            # the denominator is treated as known. Difference of two such
            # log-levels has at most sqrt(2) the std — but consecutive
            # predictions share most of their signal, so we use the YoY
            # std directly as a conservative MoM-space proxy and floor it.
            sd = max(yoy_resid_std[i], emp_mom_sd, 0.10)
            spread[i] = self._Z80 * sd

        los = means - spread
        his = means + spread
        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon YoY model
    # ------------------------------------------------------------------
    def _fit_one_horizon_yoy(
        self,
        X_full: pd.DataFrame,
        cpi: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Fit ridge + xgb on (X_T, yoy_at_T+h). Return (mean_yoy, resid_std_yoy)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        # YoY of CPI at T+h, indexed by T (so the row "T" knows the future
        # YoY). target_yoy[T] = (cpi[T+h] / cpi[T+h-12] - 1) * 100.
        # Equivalently, (cpi.shift(-h) / cpi.shift(-h+12) - 1) * 100, but
        # only for h<=12 (otherwise the denominator is the future too).
        # For h>12 we treat the 12-month-ago term as known by chaining
        # through earlier MoM-implied levels at *training time*; the race
        # uses h<=3 so this path is rare.
        target_yoy = (cpi.shift(-h) / cpi.shift(-h + 12) - 1.0) * 100.0
        target_yoy = target_yoy.rename("yoy_target")

        df = X_full.join(target_yoy, how="inner").dropna()
        if len(df) < 36:
            return self._fallback_yoy(cpi, h)

        feature_cols = [c for c in df.columns if c != "yoy_target"]
        X = df[feature_cols].values.astype(float)
        y = df["yoy_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # ---- Ridge ----
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Xs, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
        ridge_pred = float(ridge.predict(x_live_s)[0])
        ridge_resid = y - ridge.predict(Xs)

        # ---- XGBoost (optional) ----
        xgb_pred: float | None = None
        xgb_resid: np.ndarray | None = None
        try:
            from xgboost import XGBRegressor

            model = XGBRegressor(**self._XGB_PARAMS).fit(X, y)
            xgb_pred = float(model.predict(x_live)[0])
            xgb_resid = y - model.predict(X)
        except Exception:
            xgb_pred = None
            xgb_resid = None

        if xgb_pred is None:
            yoy_hat = ridge_pred
            resid = ridge_resid
        else:
            yoy_hat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        resid_std = float(np.std(resid))
        # Don't let it under-state — YoY training residuals look small
        # because the target is autocorrelated.
        resid_std = max(resid_std, 0.15)
        return yoy_hat, resid_std

    # ------------------------------------------------------------------
    # level lookup for the YoY denominator
    # ------------------------------------------------------------------
    @staticmethod
    def _level_at_offset(
        cpi: pd.Series, k: int, pred_cpi: np.ndarray
    ) -> float:
        """Get cpi[T+k] where T = cut date. k can be negative (history) or
        positive (future). For k>=0 we look it up in the predicted levels
        we've already produced (pred_cpi[k-1] holds h=k's prediction)."""
        if k <= 0:
            # k<=0 means history: cpi.iloc[-1+k] (k=-12 → 12 months ago).
            idx = -1 + k
            try:
                return float(cpi.iloc[idx])
            except Exception:
                # Out of range: fall back to last observed.
                return float(cpi.iloc[-1])
        # k>=1 → use a previously predicted level. pred_cpi[k-1] is h=k.
        # Only valid if we've already filled it; otherwise fall back.
        if k - 1 < len(pred_cpi) and not np.isnan(pred_cpi[k - 1]):
            return float(pred_cpi[k - 1])
        return float(cpi.iloc[-1])

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        return feats.iloc[-1]

    @staticmethod
    def _empirical_mom_std(cpi: pd.Series) -> float:
        mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = mom.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    @staticmethod
    def _fallback_yoy(cpi: pd.Series, h: int) -> tuple[float, float]:
        # Naive YoY = last observed YoY, persistence model.
        yoy = (cpi / cpi.shift(12) - 1.0) * 100.0
        s = yoy.dropna()
        if s.empty:
            return 0.0, 0.5
        last = float(s.iloc[-1])
        sd = float(s.tail(60).std()) if len(s) >= 12 else 0.5
        return last, max(sd, 0.2)

    # ------------------------------------------------------------------
    # whole-strategy fallback
    # ------------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            cpi = panel[TARGET.fred_id].astype(float).dropna()
            mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
            s = mom.dropna()
            last = float(s.iloc[-1]) if not s.empty else 0.0
            sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
            sd = max(sd, 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
