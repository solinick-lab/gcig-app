"""PCE-anchored CPI forecasting (Agent JJ).

CPI and PCE measure the same underlying inflation but with different
weighting: CPI uses a fixed Laspeyres-style basket, PCE uses what
consumers actually buy *now* (chained Fisher). PCE is the Fed's
preferred inflation gauge, generally less volatile, and historically
tends to lead headline CPI by roughly a month — partly because PCE
reweights faster when consumers substitute, so a price spike that
will show up in next month's CPI basket is already biting PCE.

This strategy bolts a small set of PCE-specific features onto the
shared `build_features` matrix:

    - PCEPI MoM lag1, YoY lag1, 3mo-lag1
    - PCEPILFE (Core PCE) MoM lag1, YoY lag1, 3mo-lag1
    - CPI−PCE YoY wedge (positive when CPI is overshooting PCE; the
      historical relationship suggests CPI mean-reverts toward PCE)
    - PCE acceleration: PCEPI YoY now minus PCEPI YoY 3 months ago

Direct multi-step (one model per horizon, no chained MoM), 50/50 Ridge
+ XGBoost, 80% bands from training residual std.

Falls back to the build_features baseline if PCEPI / PCEPILFE are
missing from the panel (defensive — older snapshots may lack them).
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target
from ..fred import TARGET


warnings.filterwarnings("ignore")


PCE_ID = "PCEPI"
CORE_PCE_ID = "PCEPILFE"


class PceAnchorStrategy(ForecastStrategy):
    name = "agent_jj_pce"

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
        cpi = panel[TARGET.fred_id].astype(float).dropna()
        if len(cpi) < 36:
            return self._fallback(panel, horizon)

        # Standard feature matrix from the shared builder.
        X_base = build_features(panel)

        # PCE-specific add-ons. If PCE columns are missing we just skip them
        # — the baseline features still work, the strategy gracefully
        # degrades to a plain direct multi-step ridge+xgb ensemble.
        X_pce = self._build_pce_features(panel)
        if X_pce is not None and not X_pce.empty:
            X_full = X_base.join(X_pce, how="left")
        else:
            X_full = X_base

        live_row = self._latest_feature_row(X_full)

        y_mom = build_target(panel)

        # Per-horizon direct prediction in MoM (log %) space.
        means = np.empty(horizon, dtype=float)
        spreads = np.empty(horizon, dtype=float)
        emp_sd = self._empirical_mom_std(cpi)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                mu, sd = self._fit_one_horizon(X_full, y_mom, h, live_row)
            except Exception:
                mu, sd = self._fallback_step(cpi, h)
            means[i] = mu
            # Floor std so bands don't collapse on a quiet training window.
            spreads[i] = self._Z80 * max(sd, emp_sd, 0.10)

        los = means - spreads
        his = means + spreads
        return means, los, his

    # ------------------------------------------------------------------
    # PCE-specific features
    # ------------------------------------------------------------------
    def _build_pce_features(self, panel: pd.DataFrame) -> pd.DataFrame | None:
        """Return the PCE add-on columns, or None if the panel lacks PCE."""
        if PCE_ID not in panel.columns and CORE_PCE_ID not in panel.columns:
            return None

        rows: dict[str, pd.Series] = {}

        # Headline PCE
        if PCE_ID in panel.columns:
            pce = panel[PCE_ID].astype(float)
            rows["pcepi_mom_lag1"] = self._mom(pce).shift(1)
            rows["pcepi_yoy_lag1"] = self._yoy(pce).shift(1)
            rows["pcepi_3mo_lag1"] = ((pce / pce.shift(3) - 1.0) * 100.0).shift(1)

            # PCE acceleration: how much YoY has changed in the last 3 months.
            # Positive = inflation pressure building, negative = cooling.
            yoy = self._yoy(pce)
            rows["pcepi_accel_lag1"] = (yoy - yoy.shift(3)).shift(1)

            # CPI−PCE YoY wedge. When CPI is well above PCE on a YoY basis,
            # CPI has historically mean-reverted toward PCE in the next few
            # months (PCE reweights faster, so it's a leading anchor).
            cpi = panel[TARGET.fred_id].astype(float)
            cpi_yoy = self._yoy(cpi)
            rows["cpi_pce_yoy_wedge_lag1"] = (cpi_yoy - yoy).shift(1)

        # Core PCE
        if CORE_PCE_ID in panel.columns:
            cpce = panel[CORE_PCE_ID].astype(float)
            rows["pcepilfe_mom_lag1"] = self._mom(cpce).shift(1)
            rows["pcepilfe_yoy_lag1"] = self._yoy(cpce).shift(1)
            rows["pcepilfe_3mo_lag1"] = ((cpce / cpce.shift(3) - 1.0) * 100.0).shift(1)

        if not rows:
            return None
        return pd.concat(rows, axis=1)

    @staticmethod
    def _mom(s: pd.Series) -> pd.Series:
        return (s / s.shift(1) - 1.0) * 100.0

    @staticmethod
    def _yoy(s: pd.Series) -> pd.Series:
        return (s / s.shift(12) - 1.0) * 100.0

    # ------------------------------------------------------------------
    # per-horizon model
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_mom: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        """Fit ridge + xgb on (X_T, y_{T+h}). Return (mean_mom, resid_std_mom)."""
        from sklearn.linear_model import RidgeCV
        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import TimeSeriesSplit

        # Direct h-step target: the MoM at month T+h, indexed by T.
        target = y_mom.shift(-h).rename("y_target")

        df = X_full.join(target, how="inner").dropna()
        if len(df) < 36:
            raise RuntimeError("not enough rows for direct horizon model")

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)
        if not np.all(np.isfinite(x_live)):
            # Replace any residual NaN/inf in the live row with column means
            # so we don't poison predict().
            col_means = np.nanmean(X, axis=0)
            mask = ~np.isfinite(x_live[0])
            x_live[0, mask] = col_means[mask]

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
            mu = ridge_pred
            resid = ridge_resid
        else:
            mu = 0.5 * ridge_pred + 0.5 * xgb_pred
            resid = 0.5 * ridge_resid + 0.5 * xgb_resid  # type: ignore[operator]

        sd = float(np.std(resid))
        return mu, sd

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        # We want the most recent row that has at least the core columns
        # populated — drop rows that are mostly NaN.
        feats = feats.dropna(how="all")
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        # Per-column: fall back to the last non-null value if needed.
        last = feats.iloc[-1].copy()
        if last.isna().any():
            filled = feats.ffill().iloc[-1]
            last = last.where(~last.isna(), filled)
        return last

    @staticmethod
    def _empirical_mom_std(cpi: pd.Series) -> float:
        mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = mom.dropna()
        if len(s) < 12:
            return 0.25
        return float(s.tail(60).std())

    @staticmethod
    def _fallback_step(cpi: pd.Series, h: int) -> tuple[float, float]:
        mom = (np.log(cpi) - np.log(cpi.shift(1))) * 100.0
        s = mom.dropna()
        if s.empty:
            return 0.0, 0.30
        last = float(s.iloc[-1])
        sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
        return last, max(sd, 0.15)

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
