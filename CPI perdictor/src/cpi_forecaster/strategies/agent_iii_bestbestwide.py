"""Agent III: best-of-best with the EXPANDED 37-series feature panel.

Round 5 angle. Agent EE (best-of-best, original 14-series panel) topped
out at 0.245 RFF. The previous best-of-best champion ran at 0.268. The
hypothesis: the per-horizon model-selection meta-strategy is sound, but
the original feature panel was the bottleneck. Now that build_features
iterates over the full 37-series FEATURES tuple — adding inflation
expectations (T5YIE, T10YIE), alternative inflation measures
(MEDCPIM158SFRBCLE, STICKCPIM157SFRBATL), yield-curve / policy signals
(T10Y2Y), credit spreads (BAMLH0A0HYM2), labor depth (JTSJOL), consumer
sentiment (UMCSENT), PCE (PCEPI), housing leading indicators (HOUST),
capacity utilization (TCU), and Brent crude (DCOILBRENTEU), among others
— we re-run best-of-best on top of that wider panel.

Three base learners are evaluated for each horizon:
  a) Quantile median GBR (loss='quantile', alpha=0.5) — direct multi-step.
  b) Bagging-Ridge — recursive-from-features.
  c) Direct-XGB — direct multi-step.

For each horizon h:
  1. Score each learner's MAE on the last 12 months of training data
     using rolling-1-step-CV.
  2. Pick the lowest-MAE learner for THAT horizon.
  3. Re-fit on the full training data, predict h.
  4. Build 80% intervals from native intervals where available, or
     residual-std × 1.2816 otherwise.

Self-contained: does NOT import from sibling agent_*.py files. The
"wide" panel is automatic — build_features in this repo already pulls
MoM-lag1 + YoY-lag1 for every FEATURES series.
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from . import ForecastStrategy
from ..features import build_features, build_target


warnings.filterwarnings("ignore")


# ----------------------------- constants -------------------------------

_Z80 = 1.2816                    # one-sided z for 80% interval
_MOM_LO_CLIP = -1.5              # MoM percent floor (sanity)
_MOM_HI_CLIP = 2.5               # MoM percent ceiling (sanity)
_RESID_FLOOR = 0.10              # don't let intervals collapse on tight fits
_MIN_TRAIN_ROWS = 36             # below this we don't bother fitting full models
_CV_WINDOW = 12                  # rolling-1-step-CV horizon for selection
_CV_MIN_TRAIN = 24               # minimum points to start CV
_RANDOM_STATE = 42

# Three learner identifiers.
_LEARNER_QUANTILE = "quantile"
_LEARNER_BAGGING = "bagging"
_LEARNER_XGB = "xgb"


# ----------------------------- helpers ---------------------------------

def _last_observed_mom(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if s.empty:
        return 0.0
    return float(s.iloc[-1])


def _empirical_mom_std(y_full: pd.Series) -> float:
    s = y_full.dropna()
    if len(s) < 12:
        return 0.25
    return float(s.tail(60).std())


def _latest_feature_row(X_full: pd.DataFrame) -> pd.Series:
    """Most recent feature row at the cut date, with small ffill.

    The wide panel introduces series with looser publication lags
    (e.g. JOLTS, housing starts), so a couple of forward-fills here
    keep us from dropping the live row over a single missing cell.
    """
    feats = X_full.copy()
    feats = feats.ffill(limit=2)
    feats = feats.dropna(how="any")
    if feats.empty:
        raise RuntimeError("No usable feature row at cut date.")
    return feats.iloc[-1]


def _roll_cpi_lags(feat_row: pd.Series, yhat: float) -> pd.Series:
    """Recursive update — slide CPI MoM lag1/2/3, freeze macro covariates."""
    out = feat_row.copy()
    if "cpi_mom_lag3" in out and "cpi_mom_lag2" in out:
        out["cpi_mom_lag3"] = out["cpi_mom_lag2"]
    if "cpi_mom_lag2" in out and "cpi_mom_lag1" in out:
        out["cpi_mom_lag2"] = out["cpi_mom_lag1"]
    if "cpi_mom_lag1" in out:
        out["cpi_mom_lag1"] = yhat
    return out


# ----------------------------- the strategy ----------------------------


class BestOfBestWideStrategy(ForecastStrategy):
    """Per-horizon model selection over three diverse base learners,
    operating on the expanded 37-series feature panel."""

    name = "agent_iii_bestbestwide"

    def fit_and_predict(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            return self._main(panel, horizon)
        except Exception:
            return self._naive(panel, horizon)

    # ------------------------------------------------------------------
    # main path
    # ------------------------------------------------------------------
    def _main(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        # build_features iterates over the full FEATURES tuple, so the
        # "wide" 37-series panel is automatic — every series contributes
        # MoM-lag1 + YoY-lag1 columns.
        X_full = build_features(panel)
        y_full = build_target(panel)

        if X_full.empty or y_full.dropna().empty:
            return self._naive(panel, horizon)

        live_row = _latest_feature_row(X_full)

        means = np.empty(horizon, dtype=float)
        los = np.empty(horizon, dtype=float)
        his = np.empty(horizon, dtype=float)

        for i, h in enumerate(range(1, horizon + 1)):
            try:
                yhat, lo, hi = self._predict_one_horizon(
                    X_full, y_full, h, live_row, panel
                )
            except Exception:
                yhat = _last_observed_mom(y_full)
                sd = max(_empirical_mom_std(y_full), _RESID_FLOOR)
                spread = _Z80 * sd
                lo = yhat - spread
                hi = yhat + spread

            yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Sanity floor on band width.
            if (hi - yhat) < _RESID_FLOOR:
                hi = yhat + _RESID_FLOOR
            if (yhat - lo) < _RESID_FLOOR:
                lo = yhat - _RESID_FLOOR

            means[i] = yhat
            los[i] = lo
            his[i] = hi

        return means, los, his

    # ------------------------------------------------------------------
    # per-horizon: select then refit then predict
    # ------------------------------------------------------------------
    def _predict_one_horizon(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
        panel: pd.DataFrame,
    ) -> tuple[float, float, float]:
        """Score each learner via rolling CV, pick best, re-fit, predict."""

        # Build aligned (X, y_{T+h}) for direct multi-step learners.
        y_target = y_full.shift(-h).rename("y_target")
        df = X_full.join(y_target, how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            yhat = _last_observed_mom(y_full)
            sd = max(_empirical_mom_std(y_full), _RESID_FLOOR)
            return yhat, yhat - _Z80 * sd, yhat + _Z80 * sd

        feature_cols = [c for c in df.columns if c != "y_target"]

        # Score the three learners on the last 12 months via rolling CV.
        scores: dict[str, float] = {}
        try:
            scores[_LEARNER_QUANTILE] = self._cv_quantile(df, feature_cols)
        except Exception:
            scores[_LEARNER_QUANTILE] = np.inf
        try:
            scores[_LEARNER_BAGGING] = self._cv_bagging(
                X_full, y_full, h, panel
            )
        except Exception:
            scores[_LEARNER_BAGGING] = np.inf
        try:
            scores[_LEARNER_XGB] = self._cv_xgb(df, feature_cols)
        except Exception:
            scores[_LEARNER_XGB] = np.inf

        # Pick lowest-MAE. Tie-break: quantile > bagging > xgb (deterministic).
        finite = {k: v for k, v in scores.items() if np.isfinite(v)}
        if not finite:
            chosen = _LEARNER_QUANTILE
        else:
            chosen = min(finite, key=lambda k: finite[k])

        # Re-fit chosen learner on FULL training data and produce the
        # forecast plus 80% interval.
        if chosen == _LEARNER_QUANTILE:
            return self._fit_quantile(df, feature_cols, live_row)
        if chosen == _LEARNER_BAGGING:
            return self._fit_bagging(X_full, y_full, h, live_row, panel)
        # Default: xgb
        return self._fit_xgb(df, feature_cols, live_row, y_full)

    # ------------------------------------------------------------------
    # rolling-1-step-CV scorers (last 12 months, predict h-step-ahead)
    # ------------------------------------------------------------------
    def _cv_quantile(
        self, df: pd.DataFrame, feature_cols: list[str]
    ) -> float:
        from sklearn.ensemble import GradientBoostingRegressor

        n = len(df)
        if n < _CV_MIN_TRAIN + 1:
            return np.inf
        start = max(_CV_MIN_TRAIN, n - _CV_WINDOW)
        errs: list[float] = []
        for end in range(start, n):
            X_tr = df.iloc[:end][feature_cols].values.astype(float)
            y_tr = df.iloc[:end]["y_target"].values.astype(float)
            X_te = df.iloc[end:end + 1][feature_cols].values.astype(float)
            y_te = float(df.iloc[end]["y_target"])
            try:
                m = GradientBoostingRegressor(
                    loss="quantile",
                    alpha=0.5,
                    n_estimators=300,
                    max_depth=3,
                    learning_rate=0.05,
                    random_state=_RANDOM_STATE,
                ).fit(X_tr, y_tr)
                pred = float(m.predict(X_te)[0])
                errs.append(abs(pred - y_te))
            except Exception:
                continue
        if not errs:
            return np.inf
        return float(np.mean(errs))

    def _cv_xgb(
        self, df: pd.DataFrame, feature_cols: list[str]
    ) -> float:
        try:
            from xgboost import XGBRegressor
        except Exception:
            return np.inf

        n = len(df)
        if n < _CV_MIN_TRAIN + 1:
            return np.inf
        start = max(_CV_MIN_TRAIN, n - _CV_WINDOW)
        errs: list[float] = []
        for end in range(start, n):
            X_tr = df.iloc[:end][feature_cols].values.astype(float)
            y_tr = df.iloc[:end]["y_target"].values.astype(float)
            X_te = df.iloc[end:end + 1][feature_cols].values.astype(float)
            y_te = float(df.iloc[end]["y_target"])
            try:
                m = XGBRegressor(
                    n_estimators=300,
                    max_depth=3,
                    learning_rate=0.03,
                    objective="reg:squarederror",
                    n_jobs=1,
                    verbosity=0,
                    random_state=_RANDOM_STATE,
                ).fit(X_tr, y_tr)
                pred = float(m.predict(X_te)[0])
                errs.append(abs(pred - y_te))
            except Exception:
                continue
        if not errs:
            return np.inf
        return float(np.mean(errs))

    def _cv_bagging(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        panel: pd.DataFrame,
    ) -> float:
        """Score recursive-from-features bagging-Ridge: train one-step
        model, then iterate h steps from each cutoff and compare to the
        actual MoM at cutoff+h.
        """
        from sklearn.ensemble import BaggingRegressor
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline

        # Build one-step-ahead supervised: y_t depends on X_t.
        df = X_full.join(y_full.rename("y_target"), how="inner").dropna()
        n = len(df)
        if n < _CV_MIN_TRAIN + h + 1:
            return np.inf
        feature_cols = [c for c in df.columns if c != "y_target"]
        start = max(_CV_MIN_TRAIN, n - _CV_WINDOW - h)
        end_max = n - h
        if start >= end_max:
            return np.inf
        errs: list[float] = []
        for end in range(start, end_max):
            X_tr = df.iloc[:end][feature_cols].values.astype(float)
            y_tr = df.iloc[:end]["y_target"].values.astype(float)
            try:
                base = Pipeline(
                    steps=[
                        ("scaler", StandardScaler()),
                        ("ridge", Ridge(alpha=1.0)),
                    ]
                )
                try:
                    bag = BaggingRegressor(
                        estimator=base,
                        n_estimators=30,
                        max_samples=0.85,
                        bootstrap=True,
                        n_jobs=1,
                        random_state=_RANDOM_STATE,
                    ).fit(X_tr, y_tr)
                except TypeError:
                    bag = BaggingRegressor(
                        base_estimator=base,
                        n_estimators=30,
                        max_samples=0.85,
                        bootstrap=True,
                        n_jobs=1,
                        random_state=_RANDOM_STATE,
                    ).fit(X_tr, y_tr)
            except Exception:
                continue

            feat_row = df.iloc[end - 1][feature_cols].copy()
            yhat = 0.0
            ok = True
            for _step in range(h):
                x_vec = feat_row.values.astype(float).reshape(1, -1)
                try:
                    yhat = float(bag.predict(x_vec)[0])
                except Exception:
                    ok = False
                    break
                feat_row = _roll_cpi_lags(feat_row, yhat)
            if not ok:
                continue
            y_actual = float(df.iloc[end + h - 1]["y_target"])
            errs.append(abs(yhat - y_actual))

        if not errs:
            return np.inf
        return float(np.mean(errs))

    # ------------------------------------------------------------------
    # full re-fit + predict for each learner
    # ------------------------------------------------------------------
    def _fit_quantile(
        self,
        df: pd.DataFrame,
        feature_cols: list[str],
        live_row: pd.Series,
    ) -> tuple[float, float, float]:
        """Quantile median GBR; native 80% bands via q=0.1, q=0.9 GBRs too."""
        from sklearn.ensemble import GradientBoostingRegressor

        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        common = dict(
            n_estimators=300,
            max_depth=3,
            learning_rate=0.05,
            random_state=_RANDOM_STATE,
        )
        m_med = GradientBoostingRegressor(
            loss="quantile", alpha=0.5, **common
        ).fit(X, y)
        m_lo = GradientBoostingRegressor(
            loss="quantile", alpha=0.1, **common
        ).fit(X, y)
        m_hi = GradientBoostingRegressor(
            loss="quantile", alpha=0.9, **common
        ).fit(X, y)
        mid = float(m_med.predict(x_live)[0])
        lo = float(m_lo.predict(x_live)[0])
        hi = float(m_hi.predict(x_live)[0])
        triple = sorted([lo, mid, hi])
        return triple[1], triple[0], triple[2]

    def _fit_xgb(
        self,
        df: pd.DataFrame,
        feature_cols: list[str],
        live_row: pd.Series,
        y_full: pd.Series,
    ) -> tuple[float, float, float]:
        """Direct-XGB; intervals from training residual std × z."""
        from xgboost import XGBRegressor

        X = df[feature_cols].values.astype(float)
        y = df["y_target"].values.astype(float)
        x_live = live_row[feature_cols].values.astype(float).reshape(1, -1)

        m = XGBRegressor(
            n_estimators=300,
            max_depth=3,
            learning_rate=0.03,
            objective="reg:squarederror",
            n_jobs=1,
            verbosity=0,
            random_state=_RANDOM_STATE,
        ).fit(X, y)
        yhat = float(m.predict(x_live)[0])
        resid = y - m.predict(X)
        sd = max(float(np.std(resid)) * 1.2, _RESID_FLOOR)
        # x1.2 inflation: training residuals understate OOS error.
        spread = _Z80 * sd
        return yhat, yhat - spread, yhat + spread

    def _fit_bagging(
        self,
        X_full: pd.DataFrame,
        y_full: pd.Series,
        h: int,
        live_row: pd.Series,
        panel: pd.DataFrame,
    ) -> tuple[float, float, float]:
        """Bagging-Ridge recursive-from-features; intervals from per-bag
        bootstrap percentile spread."""
        from sklearn.ensemble import BaggingRegressor
        from sklearn.linear_model import Ridge
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline

        df = X_full.join(y_full.rename("y_target"), how="inner").dropna()
        if len(df) < _MIN_TRAIN_ROWS:
            yhat = _last_observed_mom(y_full)
            sd = max(_empirical_mom_std(y_full), _RESID_FLOOR)
            return yhat, yhat - _Z80 * sd, yhat + _Z80 * sd

        feature_cols = [c for c in df.columns if c != "y_target"]
        X_arr = df[feature_cols].values.astype(float)
        y_arr = df["y_target"].values.astype(float)

        base = Pipeline(
            steps=[
                ("scaler", StandardScaler()),
                ("ridge", Ridge(alpha=1.0)),
            ]
        )
        try:
            bag = BaggingRegressor(
                estimator=base,
                n_estimators=30,
                max_samples=0.85,
                bootstrap=True,
                n_jobs=1,
                random_state=_RANDOM_STATE,
            ).fit(X_arr, y_arr)
        except TypeError:
            bag = BaggingRegressor(
                base_estimator=base,
                n_estimators=30,
                max_samples=0.85,
                bootstrap=True,
                n_jobs=1,
                random_state=_RANDOM_STATE,
            ).fit(X_arr, y_arr)

        # Walk forward h steps from live_row, each step predicting via
        # the bag and feeding the prediction into cpi_mom_lag1.
        feat_row = live_row[feature_cols].copy()
        yhat = 0.0
        per_bag_final: np.ndarray = np.array([], dtype=float)

        for step in range(h):
            x_vec = feat_row.values.astype(float).reshape(1, -1)
            preds = np.empty(len(bag.estimators_), dtype=float)
            for i, est in enumerate(bag.estimators_):
                try:
                    preds[i] = float(est.predict(x_vec)[0])
                except Exception:
                    preds[i] = np.nan
            preds = preds[np.isfinite(preds)]
            if preds.size == 0:
                yhat = _last_observed_mom(y_full)
                break
            yhat = float(np.mean(preds))
            per_bag_final = preds
            feat_row = _roll_cpi_lags(feat_row, yhat)

        if per_bag_final.size >= 5:
            lo = float(np.percentile(per_bag_final, 10.0))
            hi = float(np.percentile(per_bag_final, 90.0))
            # Re-anchor on yhat with floors.
            lo = yhat - max(yhat - lo, _RESID_FLOOR)
            hi = yhat + max(hi - yhat, _RESID_FLOOR)
        else:
            sd = max(_empirical_mom_std(y_full), _RESID_FLOOR)
            lo = yhat - _Z80 * sd
            hi = yhat + _Z80 * sd

        return yhat, lo, hi

    # ------------------------------------------------------------------
    # last-resort fallback: persistence
    # ------------------------------------------------------------------
    def _naive(
        self, panel: pd.DataFrame, horizon: int
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            y = build_target(panel)
            last = _last_observed_mom(y)
            sd = max(_empirical_mom_std(y), 0.15)
        except Exception:
            last = 0.0
            sd = 0.30
        last = float(np.clip(last, _MOM_LO_CLIP, _MOM_HI_CLIP))
        means = np.full(horizon, last, dtype=float)
        spread = _Z80 * sd * np.sqrt(np.arange(1, horizon + 1))
        return means, means - spread, means + spread
