"""Agent ZZ — Diffusion index across all features.

Idea (econ tradition: Conf. Board, ISM, NBER): rather than asking *how big*
recent changes are, count *how broad* they are. For each macro feature, we
mark a month as "accelerating" when its 3-month average MoM exceeds its
12-month average MoM — i.e. recent momentum is faster than the trailing
year. The diffusion index is the share of features accelerating at each
time. >0.5 means more than half the panel is accelerating in concert,
which historically precedes coordinated CPI surprises (e.g. mid-2021,
2007–08).

We feed the index back as predictors:
  - diffusion[t-1]                      (current breadth state)
  - diffusion 3-mo MA at lag 1          (smoothed breadth)
  - diffusion z-score at lag 1          (breadth relative to its history)

Direct multi-step Ridge + XGB, 50/50 blend per horizon. 80% bands from
per-horizon residual std.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


# Window lengths for the "accelerating" definition. 3-mo vs 12-mo is the
# canonical NBER/Conf. Board split between cyclical and trend horizons.
_FAST_WINDOW = 3
_SLOW_WINDOW = 12

# Z-score window for the diffusion-index z-score feature. 60 months gives
# the index ~5 yrs of context, enough to span at least one full inflation
# cycle without going so far back that pre-1990 regimes contaminate it.
_Z_WINDOW = 60

_Z80 = 1.2816  # one-sided z for 80% interval


def _persistence_forecast(panel: pd.DataFrame, horizon: int):
    """Last observed MoM repeated. Final fallback if anything blows up."""
    try:
        last = float(build_target(panel).dropna().iloc[-1])
    except Exception:
        last = 0.20  # ~2.4% annualized prior
    m = np.full(horizon, last, dtype=float)
    spread = np.full(horizon, 0.30, dtype=float)
    return m, m - spread, m + spread


def _last_feature_row(feats: pd.DataFrame) -> pd.Series:
    """Forward-fill up to 2 months, then return the last all-non-NaN row."""
    f = feats.copy().ffill(limit=2).dropna(how="any")
    if f.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return f.iloc[-1]


def _compute_diffusion_index(panel: pd.DataFrame) -> pd.Series:
    """Cross-sectional fraction of features that are 'accelerating' at t.

    For each feature column (excluding the CPI target):
      * MoM = pct change vs prior month
      * fast_mean = 3-month rolling mean of MoM
      * slow_mean = 12-month rolling mean of MoM
      * accelerating[t] = 1 if fast_mean[t] > slow_mean[t], else 0

    diffusion[t] = mean of accelerating indicators across features at t.
    Features with NaN at t (window incomplete or series short) are simply
    excluded from that month's denominator — keeps the index defined even
    on the panel's earliest months.
    """
    target_id = TARGET.fred_id
    cols = [c for c in panel.columns if c != target_id]
    if not cols:
        return pd.Series(0.5, index=panel.index, name="diffusion")

    accel_frames: list[pd.DataFrame] = []
    for c in cols:
        s = panel[c].astype(float)
        # MoM % change. Use simple pct change — diffusion is sign-of-difference,
        # so log vs simple is irrelevant.
        mom = s.pct_change() * 100.0
        # Need both windows fully populated to vote.
        fast = mom.rolling(window=_FAST_WINDOW, min_periods=_FAST_WINDOW).mean()
        slow = mom.rolling(window=_SLOW_WINDOW, min_periods=_SLOW_WINDOW).mean()
        # 1 = accelerating, 0 = not, NaN = undefined (ignored in mean below).
        accel = (fast > slow).astype(float)
        # Re-mask the rows where either window was undefined back to NaN so
        # they don't get counted as "not accelerating".
        accel = accel.where(fast.notna() & slow.notna())
        accel_frames.append(accel.rename(c))

    if not accel_frames:
        return pd.Series(0.5, index=panel.index, name="diffusion")

    wide = pd.concat(accel_frames, axis=1)
    # Mean across features per row, ignoring NaNs. min_count=1 so a row with
    # zero defined features stays NaN (we'll fill with 0.5 prior below).
    diff = wide.mean(axis=1, skipna=True)
    diff = diff.fillna(0.5).rename("diffusion")
    return diff


def _augment_with_diffusion(
    X: pd.DataFrame, panel: pd.DataFrame
) -> pd.DataFrame:
    """Add diffusion-index features (lag-1) onto an existing feature matrix.

    Three columns are appended:
      - diffusion_lag1
      - diffusion_3mo_ma_lag1
      - diffusion_zscore_lag1
    """
    diff = _compute_diffusion_index(panel)
    diff_3mo = diff.rolling(window=3, min_periods=1).mean()
    rolling_mean = diff.rolling(window=_Z_WINDOW, min_periods=12).mean()
    rolling_std = diff.rolling(window=_Z_WINDOW, min_periods=12).std()
    z = (diff - rolling_mean) / rolling_std.replace(0, np.nan)
    z = z.fillna(0.0)

    add = pd.DataFrame(
        {
            "diffusion_lag1": diff.shift(1),
            "diffusion_3mo_ma_lag1": diff_3mo.shift(1),
            "diffusion_zscore_lag1": z.shift(1),
        },
        index=panel.index,
    )
    # Reindex to X's index in case panel has rows X doesn't.
    add = add.reindex(X.index)
    return pd.concat([X, add], axis=1)


class DiffusionIndexStrategy(ForecastStrategy):
    name = "agent_zz_diffusion"

    # Ridge alpha grid — wide because diffusion features may correlate
    # with existing momentum features and we want adaptive shrinkage.
    _RIDGE_ALPHAS = (0.1, 0.3, 1.0, 3.0, 10.0, 30.0, 100.0, 300.0)

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
        # 1) Base features + target.
        X_full = build_features(panel)
        y_full = build_target(panel)

        # 2) Add diffusion-index features.
        X_full = _augment_with_diffusion(X_full, panel)

        # 3) Live row for forecasting (panel-end).
        live_row = _last_feature_row(X_full)

        # 4) Direct multi-step: separate model per horizon h.
        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), 0.15)
            spread = _Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Fit Ridge + XGB at one horizon, blend 50/50, return (yhat, resid_std)."""
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler

        # Direct: pair X[t] with y[t+h]. (Note: build_features already shifts
        # exogenous columns by 1 so X[t] uses info available at end of t-1;
        # the target at t is then "1-step-ahead" from that info set.
        # Shifting y by -h here means we forecast h months past the target's
        # natural alignment — i.e. h+1 months past the latest known macro row.
        # That matches the convention in agent_aa/agent_z.)
        y_target = y_full.shift(-(h - 1)).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)

        x_live = np.array(
            [float(live_row.get(c, 0.0)) for c in feature_cols]
        ).reshape(1, -1)

        # --- Ridge with in-sample MSE alpha pick (cheap, robust) ---
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)
        best_ridge = None
        best_loss = np.inf
        for alpha in self._RIDGE_ALPHAS:
            try:
                m = Ridge(alpha=alpha).fit(Xs, y)
                pred = m.predict(Xs)
                loss = float(np.mean((y - pred) ** 2))
                if loss < best_loss:
                    best_loss = loss
                    best_ridge = m
            except Exception:
                continue
        if best_ridge is None:
            yhat = self._last_observed_mom(y_full)
            return yhat, max(self._empirical_mom_std(y_full), 0.15)
        ridge_pred = float(best_ridge.predict(x_live_s)[0])
        ridge_resid = y - best_ridge.predict(Xs)

        # --- XGBoost (lazy import; if unavailable just use Ridge) ---
        xgb_pred = ridge_pred
        xgb_resid = ridge_resid
        try:
            import xgboost as xgb

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
            xgb_model.fit(X, y)
            xgb_pred = float(xgb_model.predict(x_live)[0])
            xgb_resid = y - xgb_model.predict(X)
        except Exception:
            pass

        # --- 50/50 blend ---
        yhat = 0.5 * ridge_pred + 0.5 * xgb_pred
        blended_resid = 0.5 * ridge_resid + 0.5 * xgb_resid
        # In-sample residuals understate OOS error at short horizons; keep
        # a small floor so bands aren't artificially tight.
        resid_std = max(float(np.std(blended_resid)), 0.10)
        return yhat, resid_std

    # ------------------------------------------------------------------
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
