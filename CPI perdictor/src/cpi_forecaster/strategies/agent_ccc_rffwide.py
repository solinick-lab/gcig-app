"""Agent CCC — RFF on the EXPANDED 37-series panel (round 5).

Round 5 angle: agent_s_rff is the current best at 0.245 RMSE YoY using
Random Fourier Features on the OLD 14-feature panel. RFF is a kernel
method that scales gracefully to more features (the kernel approximator
just lives in a higher-D primal space; ridge stays linear-time in the
number of training rows). So the natural next try is to feed it the
WIDE panel.

Pipeline per horizon (same architecture as agent_s, just with more inputs
and a slightly bigger sampler to compensate):

    StandardScaler -> RBFSampler(n_components=300, gamma tuned via TSCV)
                   -> RidgeCV

We use build_features as the base (which already includes the round-5
panel additions via FEATURES) and then *append* additional MoM lag1 and
YoY lag1 transforms for a curated subset of round-5 series:

    T5YIE, T10YIE, MEDCPIM158SFRBCLE, STICKCPIM157SFRBATL, T10Y2Y,
    BAMLH0A0HYM2, UMCSENT, PCEPI, JTSJOL, JTSQUL, HOUST, PERMIT, TCU,
    DCOILBRENTEU, ICSA, GASDESW.

(build_features already adds these — duplicates are deduped after concat
to keep the matrix clean. The explicit list is here so the strategy
keeps producing the intended features even if FEATURES is later shrunk.)

Direct multi-step: one model per horizon h in 1..H.
80% bands: training residual std × √h × z=1.2816 (one-sided).

All-NaN columns get dropped before fitting so series with shorter
histories don't poison the design matrix.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ---- extra FRED IDs to inject MoM lag1 + YoY lag1 for ----------------
# Curated round-5 round of additions. build_features already covers these
# (via FEATURES), so the explicit re-injection here is belt-and-suspenders:
# it guarantees the feature set the agent's design specifies regardless of
# any future trimming of FEATURES.
_EXTRA_SERIES: tuple[str, ...] = (
    "T5YIE",
    "T10YIE",
    "MEDCPIM158SFRBCLE",
    "STICKCPIM157SFRBATL",
    "T10Y2Y",
    "BAMLH0A0HYM2",
    "UMCSENT",
    "PCEPI",
    "JTSJOL",
    "JTSQUL",
    "HOUST",
    "PERMIT",
    "TCU",
    "DCOILBRENTEU",
    "ICSA",
    "GASDESW",
)


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _build_wide_features(panel: pd.DataFrame) -> pd.DataFrame:
    """build_features() + extra MoM/YoY lag1 from _EXTRA_SERIES.

    Duplicates (same column name) are deduped after concat. Columns that
    are entirely NaN (e.g. a series with no overlap at this cut) are
    dropped so the kernel approximator doesn't blow up.
    """
    base = build_features(panel)

    extras: dict[str, pd.Series] = {}
    for fred_id in _EXTRA_SERIES:
        if fred_id not in panel.columns:
            continue
        col = panel[fred_id]
        if col.dropna().shape[0] < 13:
            # Need at least 13 obs for YoY; skip skinny series.
            continue
        extras[f"{fred_id}_mom_lag1"] = _mom(col).shift(1)
        extras[f"{fred_id}_yoy_lag1"] = _yoy(col).shift(1)

    if extras:
        extras_df = pd.concat(extras, axis=1)
        # base may already have these columns (build_features iterates
        # FEATURES). Keep base's version when names collide.
        new_cols = [c for c in extras_df.columns if c not in base.columns]
        if new_cols:
            base = pd.concat([base, extras_df[new_cols]], axis=1)

    base = base.replace([np.inf, -np.inf], np.nan)
    base = base.dropna(axis=1, how="all")
    return base


class RffWideStrategy(ForecastStrategy):
    """RFF + Ridge on the wide round-5 panel."""

    name = "agent_ccc_rffwide"

    _GAMMAS = (0.005, 0.01, 0.05, 0.1, 0.5)
    _RIDGE_ALPHAS = np.logspace(-3, 3, 19)
    _N_COMPONENTS = 300
    _Z80 = 1.2816  # one-sided z for 80% interval
    _SEED = 42

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
        X_full = _build_wide_features(panel)
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

            spread = self._Z80 * resid_std * np.sqrt(h)
            means[i] = yhat
            los[i] = yhat - spread
            his[i] = yhat + spread

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon fit (RFF + Ridge with TSCV-tuned gamma)
    # ------------------------------------------------------------------
    def _fit_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
    ) -> tuple[float, float]:
        from sklearn.kernel_approximation import RBFSampler
        from sklearn.linear_model import RidgeCV
        from sklearn.model_selection import TimeSeriesSplit
        from sklearn.preprocessing import StandardScaler

        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < 36:
            yhat = self._last_observed_mom(y_full)
            resid_std = max(self._empirical_mom_std(y_full), 0.15)
            return yhat, resid_std

        feature_cols = [c for c in df.columns if c != "y_target"]
        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = (
            live_row.reindex(feature_cols).astype(float).values.reshape(1, -1)
        )
        # Defensive: ffill in _latest_feature_row may still leave NaNs for
        # a freshly-added series; fill with 0 in standardized space later.
        x_live = np.nan_to_num(x_live, nan=0.0, posinf=0.0, neginf=0.0)

        # Standardize before RBF — gamma is interpretable in unit space.
        scaler = StandardScaler().fit(X)
        Xs = scaler.transform(X)
        x_live_s = scaler.transform(x_live)

        n_splits = min(5, max(2, len(df) // 60))
        tscv = TimeSeriesSplit(n_splits=n_splits)

        # Tune gamma via TSCV RMSE.
        best = None  # (cv_rmse, gamma)
        for gamma in self._GAMMAS:
            try:
                rmse = self._cv_rmse(Xs, y, tscv, gamma=gamma)
            except Exception:
                continue
            if not np.isfinite(rmse):
                continue
            if best is None or rmse < best[0]:
                best = (rmse, gamma)

        if best is None:
            # Pure ridge fallback if every RBF approx blew up.
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Xs, y)
            yhat = float(ridge.predict(x_live_s)[0])
            resid = y - ridge.predict(Xs)
            return yhat, max(float(np.std(resid)), 0.10)

        _, gamma = best

        # Refit RBFSampler + RidgeCV on the full training slice.
        sampler = RBFSampler(
            n_components=self._N_COMPONENTS,
            gamma=gamma,
            random_state=self._SEED,
        ).fit(Xs)
        Z = sampler.transform(Xs)
        z_live = sampler.transform(x_live_s)

        try:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS, cv=tscv).fit(Z, y)
        except Exception:
            ridge = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Z, y)

        yhat = float(ridge.predict(z_live)[0])
        resid = y - ridge.predict(Z)
        resid_std = max(float(np.std(resid)), 0.10)
        return yhat, resid_std

    # ------------------------------------------------------------------
    # CV helper
    # ------------------------------------------------------------------
    def _cv_rmse(
        self,
        Xs: np.ndarray,
        y: np.ndarray,
        tscv,
        gamma: float,
    ) -> float:
        from sklearn.kernel_approximation import RBFSampler
        from sklearn.linear_model import RidgeCV

        errs: list[float] = []
        for tr_idx, va_idx in tscv.split(Xs):
            X_tr, X_va = Xs[tr_idx], Xs[va_idx]
            y_tr, y_va = y[tr_idx], y[va_idx]

            sampler = RBFSampler(
                n_components=self._N_COMPONENTS,
                gamma=gamma,
                random_state=self._SEED,
            ).fit(X_tr)

            Z_tr = sampler.transform(X_tr)
            Z_va = sampler.transform(X_va)
            try:
                model = RidgeCV(alphas=self._RIDGE_ALPHAS).fit(Z_tr, y_tr)
            except Exception:
                continue
            pred = model.predict(Z_va)
            errs.append(float(np.sqrt(np.mean((y_va - pred) ** 2))))

        if not errs:
            return float("inf")
        return float(np.mean(errs))

    # ------------------------------------------------------------------
    # misc helpers
    # ------------------------------------------------------------------
    @staticmethod
    def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
        feats = X_full.copy()
        feats = feats.ffill(limit=2)
        if feats.empty:
            raise RuntimeError("No usable feature row at cut date.")
        # Don't dropna across columns — newer series may legitimately be
        # NaN at the latest cut; reindex+fillna(0) at use site instead.
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
