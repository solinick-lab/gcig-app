"""Agent GGG — TIPS-only minimalist.

Pure market-implied test: use ONLY the three breakeven series
(T5YIE, T10YIE, T5YIFR) and CPI's own lags. No oil, no PPI, no
shelter, no surveys, no labor. Strip away every macro covariate
and ask the question directly: do the bond markets, on their own,
already know enough to forecast monthly CPI?

Breakevens are produced by people putting capital at risk. They
update daily, embed a liquidity/risk premium that covaries with
real macro stress, and price *expected* inflation across multiple
horizons. The 5Y5Y forward (T5YIFR) is especially clean — it
strips out the near-term oil-driven noise that dominates T5YIE.

If this minimalist strategy is competitive with the kitchen-sink
agents, that's evidence the market's forward-looking pricing
already captures most of what the heavy feature engineering picks
up. If it's not competitive, then there's real, non-redundant
signal in the supply-side hard data.

Strategy is dropped if any of T5YIE/T10YIE/T5YIFR is missing from
the panel — the angle requires all three.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target


warnings.filterwarnings("ignore")


_TIPS_IDS = ("T5YIE", "T10YIE", "T5YIFR")


def _log_mom_pct(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


class TipsOnlyStrategy(ForecastStrategy):
    name = "agent_ggg_tipsonly"

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
    _Z80 = 1.2816

    # --------------------------------------------------------------
    # entry point
    # --------------------------------------------------------------
    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # Strict requirement: all three breakevens must be present.
        for tid in _TIPS_IDS:
            if tid not in panel.columns:
                return self._fallback(panel, horizon)
        try:
            return self._inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    def _inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = self._build_features(panel)
        y_full = build_target(panel)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(X_full, y_full, h, live_row)
            except Exception:
                yhat = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), 0.15)
            spread = self._Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # --------------------------------------------------------------
    # feature engineering — TIPS-only minimalist
    # --------------------------------------------------------------
    def _build_features(self, panel: pd.DataFrame) -> pd.DataFrame:
        """Strict feature set per the spec — nothing else allowed."""
        rows: dict[str, pd.Series] = {}

        # ---- CPI MoM lags 1, 2, 3, 6, 12 ----
        cpi = panel.get("CPIAUCSL")
        if cpi is not None:
            cpi_mom = _log_mom_pct(cpi)
            rows["cpi_mom_lag1"] = cpi_mom.shift(1)
            rows["cpi_mom_lag2"] = cpi_mom.shift(2)
            rows["cpi_mom_lag3"] = cpi_mom.shift(3)
            rows["cpi_mom_lag6"] = cpi_mom.shift(6)
            rows["cpi_mom_lag12"] = cpi_mom.shift(12)

        # ---- Each TIPS series: level, MoM (1-mo diff), 3mo diff, lag 1 ----
        # "MoM" for breakevens = month-over-month change in level (these
        # are already quoted in percent, so a difference is the natural
        # unit).
        for tid in _TIPS_IDS:
            s = panel[tid]
            rows[f"{tid}_level"] = s.shift(1)               # current level (lag 1 to avoid leakage)
            rows[f"{tid}_mom"] = (s - s.shift(1)).shift(1)  # 1-month change
            rows[f"{tid}_3mo"] = (s - s.shift(3)).shift(1)  # 3-month change
            rows[f"{tid}_lag1"] = s.shift(2)                # an additional lag of the level

        # ---- Term-structure spreads ----
        slope = panel["T10YIE"] - panel["T5YIE"]
        rows["tips_slope"] = slope.shift(1)

        fwd_minus_spot = panel["T5YIFR"] - panel["T5YIE"]
        rows["tips_fwd_minus_spot"] = fwd_minus_spot.shift(1)

        feats = pd.concat(rows, axis=1)
        return feats

    # --------------------------------------------------------------
    # per-horizon fit — Ridge + XGBoost ensemble (50/50)
    # --------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        # ---- Ridge with time-series CV alpha selection ----
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

        # ---- XGBoost (fall back to ridge-only if unavailable) ----
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

        resid_std = float(np.std(resid))
        # Floor — training residuals understate true OOS spread.
        resid_std = max(resid_std, 0.10)
        return yhat, resid_std

    # --------------------------------------------------------------
    # helpers
    # --------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        feats = feats.dropna(how="any")
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

    # --------------------------------------------------------------
    # whole-strategy fallback (used if any TIPS series is missing or
    # the inner pipeline blows up)
    # --------------------------------------------------------------
    def _fallback(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = self._last_observed_mom(y)
            sd = max(self._empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        means = np.full(horizon, last, dtype=float)
        spread = self._Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
