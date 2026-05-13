"""Agent FF — TIPS breakeven specialist.

The bond market prices inflation expectations in real time. T5YIE, T10YIE
and T5YIFR are the three core market-implied gauges:
  - T5YIE   : nominal 5Y minus 5Y TIPS yield → average expected CPI
              inflation over the next 5 years.
  - T10YIE  : same idea over 10 years.
  - T5YIFR  : the 5Y forward 5Y rate — what the market thinks the average
              inflation rate will be over years 6-10. Best proxy for
              "long-run" expectations, more decoupled from spot oil.

Unlike survey-based MICH or UMCSENT these update daily, are produced by
people putting capital at risk, and embed a liquidity/risk premium that
covaries with real macro stress. They do not cleanly predict next-month
MoM on their own (the market is noisy at high frequency) but the LEVEL
and SHIFTS of the curve are surprisingly informative about medium-term
inflation regime, and the SLOPE (T10YIE - T5YIE) is a clean read on
whether the market expects the near-term shock to fade or persist.

Approach:
  - Build a focused feature matrix: TIPS levels + multi-horizon changes
    + a small set of fast-moving macro covariates (oil MoM, PPI MoM,
    shelter YoY, wages YoY, MICH YoY, CPI lags). Keeps dimensionality
    low → less overfitting on this short panel.
  - Direct multi-step: one model per horizon h, mapping X_T → y_{T+h}.
  - Per-horizon ensemble of Ridge (TimeSeriesSplit-CV alpha) and a small
    XGBoost. 50/50 blend.
  - 80% bands from per-horizon residual std × z=1.2816, with a floor.

Falls back to the standard FEATURES path if the TIPS columns aren't in
the panel (older snapshots) so the strategy never crashes the race.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_target


warnings.filterwarnings("ignore")


# Series we want to lean on. The TIPS three are the "primary" signals;
# the macro covariates round out the model so it can see the supply-side
# pressure sources the breakevens are reacting to.
_TIPS_IDS = ("T5YIE", "T10YIE", "T5YIFR")
_MACRO_IDS = (
    "DCOILWTICO",       # WTI oil — energy pass-through
    "PPIACO",           # PPI all commodities — pipeline pressure
    "CUSR0000SAH1",     # CPI Shelter — sticky component
    "CES0500000003",    # Avg hourly earnings — wage push
    "MICH",             # Michigan 1Y inflation expectations — survey complement
)


def _mom_pct(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy_pct(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _log_mom_pct(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


class TipsStrategy(ForecastStrategy):
    name = "agent_ff_tips"

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
        try:
            return self._inner(panel, horizon)
        except Exception:
            return self._fallback(panel, horizon)

    def _inner(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        X_full = self._build_tips_features(panel)
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
    # feature engineering — TIPS-centric
    # --------------------------------------------------------------
    def _build_tips_features(self, panel: pd.DataFrame) -> pd.DataFrame:
        """Compact feature matrix focused on market-implied inflation
        expectations, with a short macro tail to anchor the model.

        If the TIPS columns aren't in the panel (older snapshots), build
        from the macro tail only — the strategy still runs, just without
        its primary edge.
        """
        rows: dict[str, pd.Series] = {}
        cols = panel.columns

        # ---- CPI lags (always available; cheap to add and helpful) ----
        cpi = panel.get("CPIAUCSL")
        if cpi is not None:
            rows["cpi_mom_lag1"] = _log_mom_pct(cpi).shift(1)
            rows["cpi_mom_lag2"] = _log_mom_pct(cpi).shift(2)
            rows["cpi_mom_lag3"] = _log_mom_pct(cpi).shift(3)
            rows["cpi_yoy_lag1"] = _yoy_pct(cpi).shift(1)

        # ---- TIPS block — the headline angle ----
        tips_present = [tid for tid in _TIPS_IDS if tid in cols]
        for tid in tips_present:
            s = panel[tid]
            # Level (lag 1): the level itself is the market's point
            # estimate of average inflation; ridge will weight this.
            rows[f"{tid}_lvl_lag1"] = s.shift(1)
            # 1-month CHANGE in level (not pct change — these are already
            # quoted in percent, so a difference is the natural unit).
            rows[f"{tid}_chg1m_lag1"] = (s - s.shift(1)).shift(1)
            # 3-month change — captures regime drift, less daily noise.
            rows[f"{tid}_chg3m_lag1"] = (s - s.shift(3)).shift(1)
            # 12-month change — full-cycle move in expectations.
            rows[f"{tid}_chg12m_lag1"] = (s - s.shift(12)).shift(1)
            # Lag of level at t-1 (already covered by lvl_lag1 above) —
            # add a deeper lag for regression to fit slope across two
            # months of history without leakage.
            rows[f"{tid}_lvl_lag2"] = s.shift(2)

        # ---- Term-structure slope of breakevens ----
        if "T5YIE" in cols and "T10YIE" in cols:
            spread = panel["T10YIE"] - panel["T5YIE"]
            rows["tips_slope_lag1"] = spread.shift(1)
            rows["tips_slope_chg3m_lag1"] = (spread - spread.shift(3)).shift(1)

        if "T5YIFR" in cols and "T5YIE" in cols:
            # Forward-vs-spot: if the 5Y5Y forward is well above the
            # 5Y, market expects inflation to be higher far out — useful
            # signal for regime.
            fwd_minus_spot = panel["T5YIFR"] - panel["T5YIE"]
            rows["tips_fwd_minus_spot_lag1"] = fwd_minus_spot.shift(1)

        # ---- Macro tail (small & focused) ----
        for mid in _MACRO_IDS:
            if mid not in cols:
                continue
            s = panel[mid]
            if mid in ("CUSR0000SAH1", "CES0500000003", "MICH"):
                # Sticky / slow-moving — YoY is the right horizon.
                rows[f"{mid}_yoy_lag1"] = _yoy_pct(s).shift(1)
            else:
                # Fast-moving — MoM is the right horizon.
                rows[f"{mid}_mom_lag1"] = _mom_pct(s).shift(1)

        # ---- Calendar — residual seasonality ----
        idx = panel.index
        rows["month_sin"] = pd.Series(
            np.sin(2 * np.pi * idx.month / 12.0), index=idx
        )
        rows["month_cos"] = pd.Series(
            np.cos(2 * np.pi * idx.month / 12.0), index=idx
        )

        feats = pd.concat(rows, axis=1)
        return feats

    # --------------------------------------------------------------
    # per-horizon fit — Ridge + XGBoost ensemble
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

        # ---- Ridge w/ time-series CV alpha ----
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
    # whole-strategy fallback
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
