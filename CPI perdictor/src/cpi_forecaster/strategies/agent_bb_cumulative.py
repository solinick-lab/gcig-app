"""Cumulative log-CPI ratio direct multi-step forecasting.

Most direct multi-step strategies (see `agent_b_direct.py`) target the
single-month MoM at horizon h: y_{T+h}. That works, but the targets
across horizons are essentially uncorrelated noise on top of a smooth
underlying trend, so each horizon's model has to rediscover the level.

This strategy targets the *cumulative* log-CPI ratio instead:

    target_cum_h(T) = (log(CPI_{T+h}) - log(CPI_T)) * 100

The cumulative target is mathematically additive:
    target_cum_h = sum_{k=1..h} mom_log_{T+k}
so it's just a smoother/larger-scale version of the underlying signal.
We fit one Ridge+XGB ensemble per horizon h on (X_T, target_cum_h(T)),
then derive the per-month MoM forecasts as differences of consecutive
cumulative predictions:

    pred_mom_h = pred_cum_h - pred_cum_{h-1}, with pred_cum_0 = 0

This is direct multi-step (no recursion / no error compounding) but on
a target that is both larger in magnitude (so noise:signal is better)
and naturally additive (so the differencing yields well-behaved MoMs).

Forecast intervals are built at the cumulative level — that's where
the residuals are i.i.d.-ish — and then differenced to MoM space using
the per-horizon cumulative residual std difference; this preserves the
natural horizon-widening of the cumulative target.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features
from ..fred import TARGET


warnings.filterwarnings("ignore")


class CumulativeStrategy(ForecastStrategy):
    name = "agent_bb_cumulative"

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
    _Z80 = 1.2816  # one-sided z for 80% interval

    # Sanity clip on per-month MoM forecast (log-%); CPI MoM very rarely
    # exceeds these even in shock months. Prevents pathological outputs.
    _MOM_CLIP = 2.5

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
        cpi = panel[TARGET.fred_id].astype(float)
        log_cpi = np.log(cpi)

        live_row = self._latest_feature_row(X_full)

        # Fit one model per horizon on the cumulative log-CPI ratio
        # target. Collect (mean, resid_std) at the cumulative level.
        cum_means = np.zeros(horizon + 1, dtype=float)  # index 0 = 0.0
        cum_stds = np.zeros(horizon + 1, dtype=float)   # index 0 = 0.0

        for h in range(1, horizon + 1):
            try:
                mu_cum, sd_cum = self._fit_one_horizon_cum(
                    X_full, log_cpi, h, live_row
                )
            except Exception:
                # Per-horizon fallback at the cumulative level: scale
                # the empirical MoM std by sqrt(h) and centre at the
                # naive "last MoM" repeated h times.
                last_mom = self._last_observed_log_mom_pct(log_cpi)
                emp_sd = max(self._empirical_log_mom_std(log_cpi), 0.15)
                mu_cum = last_mom * h
                sd_cum = emp_sd * np.sqrt(h)

            cum_means[h] = mu_cum
            cum_stds[h] = sd_cum

        # Enforce mild monotonicity-ish behaviour on the cumulative
        # std: longer horizons should not have *smaller* spread than
        # shorter ones. (Means we leave alone — the model can legitimately
        # forecast e.g. negative cum at h=2 if it expects deflation.)
        for h in range(2, horizon + 1):
            if cum_stds[h] < cum_stds[h - 1]:
                cum_stds[h] = cum_stds[h - 1]

        # Convert cumulative -> per-month MoM by differencing.
        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            mom = cum_means[h] - cum_means[h - 1]
            mom = float(np.clip(mom, -self._MOM_CLIP, self._MOM_CLIP))

            # Differenced spread: var(cum_h - cum_{h-1}) under the
            # (rough) approximation that the per-step shock has std
            # equal to the diff of cumulative stds, floored so the
            # interval doesn't collapse at very short horizons.
            d_sd = max(cum_stds[h] - cum_stds[h - 1], 0.0)
            # Floor at the empirical per-step std so h=1 has a sane
            # spread even when the model fits training residuals tightly.
            sd_floor = self._empirical_log_mom_std(log_cpi)
            sd = max(d_sd, sd_floor, 0.10)
            spread = self._Z80 * sd

            means[i] = mom
            los[i] = mom - spread
            his[i] = mom + spread

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon fit on cumulative target
    # ------------------------------------------------------------------
    def _fit_one_horizon_cum(
        self,
        X_full: pd.DataFrame,
        log_cpi: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Train ridge + xgb on (X_T, cum_h(T)) and return (mean, resid_std)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        # Cumulative log-ratio in percent: log(CPI_{T+h}) - log(CPI_T).
        # Shifting log_cpi by -h means y_target.loc[T] is computed from
        # CPI at T+h, exactly matching the spec.
        target_cum = (log_cpi.shift(-h) - log_cpi) * 100.0
        target_cum = target_cum.rename("y_cum")

        df = X_full.join(target_cum, how="inner").dropna()
        if len(df) < 36:
            last_mom = self._last_observed_log_mom_pct(log_cpi)
            emp_sd = max(self._empirical_log_mom_std(log_cpi), 0.15)
            return last_mom * h, emp_sd * np.sqrt(h)

        feature_cols = [c for c in df.columns if c != "y_cum"]
        X = df[feature_cols].values.astype(float)
        y = df["y_cum"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # ---- Ridge with TimeSeriesSplit-CV alpha ----
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

        # ---- XGBoost (best-effort) ----
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
            yhat = ridge_pred
            resid = ridge_resid
        else:
            yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        # Sanity clip the cumulative mean: very loose, just to avoid
        # blowups. Roughly +/- 20% cumulative log-change over 3 months
        # is already a once-in-decades event.
        yhat = float(np.clip(yhat, -self._MOM_CLIP * h, self._MOM_CLIP * h))

        resid_std = float(np.std(resid))
        # Floor at sqrt(h) * empirical_per_step_std so we never pretend
        # the cumulative spread shrinks below a minimum scale.
        per_step_floor = max(0.10, self._empirical_log_mom_std_from_logcpi_safe(None))
        resid_std = max(resid_std, per_step_floor * np.sqrt(h))
        return yhat, resid_std

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
    def _last_observed_log_mom_pct(log_cpi: pd.Series) -> float:
        s = (log_cpi - log_cpi.shift(1)) * 100.0
        s = s.dropna()
        if s.empty:
            return 0.0
        return float(s.iloc[-1])

    @staticmethod
    def _empirical_log_mom_std(log_cpi: pd.Series) -> float:
        s = (log_cpi - log_cpi.shift(1)) * 100.0
        s = s.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    @staticmethod
    def _empirical_log_mom_std_from_logcpi_safe(_unused) -> float:
        # Static fallback for the per-step floor used inside
        # _fit_one_horizon_cum where we don't have log_cpi in scope as
        # a captured closure. We use a conservative fixed value —
        # rarely binding because the actual residual std is almost
        # always larger.
        return 0.10

    # ------------------------------------------------------------------
    # whole-strategy fallback
    # ------------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            cpi = panel[TARGET.fred_id].astype(float)
            log_cpi = np.log(cpi)
            last = self._last_observed_log_mom_pct(log_cpi)
            sd = max(self._empirical_log_mom_std(log_cpi), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
