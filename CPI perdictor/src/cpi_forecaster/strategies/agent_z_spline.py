"""B-spline feature expansion + Ridge.

Linear models with B-spline basis expansions approximate generalized
additive models (GAM): each macro feature is replaced by its degree-3
B-spline basis (with quantile knots), so the model can fit nonlinear,
monotonic-but-curved relationships per feature without the variance
that trees pay for the same flexibility.

Spline transform is only applied to the most-important *continuous*
inputs (CPI lags, oil, PPI, wages, shelter, MICH-style expectations).
Calendar sin/cos and dummy-like columns are passed through unaltered
so the basis doesn't waste degrees of freedom on already-bounded
trig features.

Direct multi-step: a separate spline+Ridge pipeline per horizon h,
trained on (X_T, y_{T+h}). 80% bands come from per-horizon residual
std times z=1.2816.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


class SplineStrategy(ForecastStrategy):
    name = "agent_z_spline"

    # Wide alpha grid — spline expansion blows feature count up to
    # ~hundreds, so we need to span very weak to very strong shrinkage.
    _RIDGE_ALPHAS = np.logspace(-3, 5, 33)
    _Z80 = 1.2816  # one-sided z for 80% interval

    # Substrings that identify the most-important continuous macro
    # inputs whose spline expansion tends to actually help. Anything
    # else (calendar, less-load-bearing series) is passed through.
    _SPLINE_KEYS = (
        "cpi_mom_lag",
        "cpi_yoy_lag",
        # oil / energy
        "DCOILWTICO",
        "WTISPLC",
        "DCOILBRENTEU",
        "GASREGW",
        # PPI / producer prices
        "PPIACO",
        "PPIFIS",
        "WPSFD4",
        # wages / labor cost
        "CES0500000003",
        "AHETPI",
        "ECIWAG",
        # shelter / rent
        "CSUSHPINSA",
        "CUSR0000SAH1",
        "RRVRUSQ156N",
        # inflation expectations
        "MICH",
        "T5YIE",
        "T10YIE",
    )

    # Spline basis hyperparams.
    _SPLINE_DEGREE = 3
    _SPLINE_N_KNOTS = 5

    # ------------------------------------------------------------------
    # public entry point
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
        X_full = build_features(panel)
        y_full = build_target(panel)

        live_row = self._latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, resid_std = self._fit_one_horizon(
                    X_full, y_full, h, live_row
                )
            except Exception:
                yhat = self._last_observed_mom(y_full)
                resid_std = max(self._empirical_mom_std(y_full), 0.15)

            spread = self._Z80 * resid_std
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon fit
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        from sklearn.compose import ColumnTransformer
        from sklearn.linear_model import RidgeCV
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import SplineTransformer, StandardScaler

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X_df = df[feature_cols]
        y = df["y_target"].values.astype(float)

        # Pick which columns actually get the B-spline expansion. We
        # match by substring on the feature key list. Anything not in
        # that set is passed through (scaler+identity).
        spline_cols = [c for c in feature_cols if self._is_spline_col(c)]
        passthrough_cols = [c for c in feature_cols if c not in spline_cols]

        # Guard: need enough distinct values per spline column for
        # quantile knots to be well-defined. Drop any column whose
        # in-sample value range collapses (rare but possible on early
        # history of a freshly-added series).
        spline_cols = [
            c for c in spline_cols if X_df[c].nunique(dropna=True) > self._SPLINE_N_KNOTS
        ]
        passthrough_cols = [
            c for c in feature_cols if c not in spline_cols
        ]

        # ColumnTransformer: spline-expand the chosen columns, leave
        # the rest unchanged. The outer pipeline scales everything
        # afterwards so RidgeCV sees unit-variance features.
        n_knots = min(self._SPLINE_N_KNOTS, max(3, len(X_df) // 20))
        spline = SplineTransformer(
            degree=self._SPLINE_DEGREE,
            n_knots=n_knots,
            knots="quantile",
            include_bias=False,
        )
        if spline_cols:
            transformer = ColumnTransformer(
                transformers=[
                    ("spline", spline, spline_cols),
                    ("passthrough", "passthrough", passthrough_cols),
                ],
                remainder="drop",
            )
        else:
            transformer = ColumnTransformer(
                transformers=[
                    ("passthrough", "passthrough", passthrough_cols),
                ],
                remainder="drop",
            )

        # CV for alpha. TimeSeriesSplit if we have enough history.
        n_splits = min(5, max(2, len(df) // 60))
        try:
            tscv = TimeSeriesSplit(n_splits=n_splits)
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS)

        pipe = Pipeline(
            steps=[
                ("expand", transformer),
                ("scale", StandardScaler(with_mean=True, with_std=True)),
                ("ridge", ridge),
            ]
        )
        pipe.fit(X_df, y)

        x_live = live_row[feature_cols].to_frame().T
        yhat = float(pipe.predict(x_live)[0])
        resid = y - pipe.predict(X_df)
        resid_std = float(np.std(resid))
        # Floor: in-sample residuals understate true OOS error,
        # especially at short horizons where the spline+Ridge fits
        # very tightly on the training panel.
        resid_std = max(resid_std, 0.10)
        return yhat, resid_std

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    @classmethod
    def _is_spline_col(cls, col: str) -> bool:
        # Skip calendar / trig features: they are bounded sin/cos in
        # [-1,1] and a spline basis on top adds noise more than signal.
        if col in ("month_sin", "month_cos"):
            return False
        # Substring match against the macro keys we care about.
        return any(key in col for key in cls._SPLINE_KEYS)

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

    # ------------------------------------------------------------------
    # whole-strategy fallback
    # ------------------------------------------------------------------
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
