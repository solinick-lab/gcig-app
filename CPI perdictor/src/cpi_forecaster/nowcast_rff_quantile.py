"""RFF feature expansion + quantile head CPI nowcaster.

The pure quantile nowcaster (`nowcast_quantile.py`) fits three GBRs at
alpha = 0.1, 0.5, 0.9 directly on the within-month feature panel. GBR's
tree splits express nonlinearity as piecewise constants, which is fine
but tends to step-jump near decision boundaries — a poor fit when the
underlying signal (oil-driven energy CPI, breakeven inflation expectations)
moves smoothly.

This variant pipes the supervised features through an RBF kernel
approximation (RBFSampler / random Fourier features) BEFORE the quantile
GBR. The 200 random Fourier features are smooth basis functions, so the
quantile head sees a richer nonlinear representation that combines well
with the additive ensemble of trees. The RFF pattern is proven to help
on small monthly panels in `strategies/agent_s_rff.py`.

Pipeline per quantile:
    StandardScaler -> RBFSampler(n_components=200, gamma=g, seed=42)
                  -> GradientBoostingRegressor(loss='quantile', alpha=q)

`gamma` is tuned per cut on a small grid via internal TimeSeriesSplit-CV
on the median-quantile head — pick whichever gamma minimizes h=0 RMSE.
The tuned gamma is then reused for all three quantile heads (lo/med/hi).

After the three quantile predictions come back, sort to enforce
monotonicity (q0.1 <= q0.5 <= q0.9), clip MoM to [-1.5, 2.5], chain to
YoY against the actual published CPI from 12 months prior.

Each historical cut is wrapped in try/except — a single bad fit
shouldn't tank the 24-cut walk-forward backtest.

Fit time target: <30s per cut.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.kernel_approximation import RBFSampler
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_GAMMAS = (0.01, 0.05, 0.1)
_N_COMPONENTS = 200
_SEED = 42

_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval to avoid collapse

_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    random_state=_SEED,
)


@dataclass
class RFFQuantileNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class RFFQuantileNowcastModel:
    scaler: StandardScaler
    sampler: RBFSampler
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]
    gamma: float
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (pred_mom_median, lo10, hi90) for one feature row.

        Sorts the triple to enforce monotonicity in case of quantile
        crossing. The middle of the sorted triple is the point forecast.
        """
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        x_s = self.scaler.transform(x_aligned)
        z_live = self.sampler.transform(x_s)
        preds: list[float] = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(z_live)[0]))
        # preds = [q0.1, q0.5, q0.9] in order
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


# --- gamma tuning ----------------------------------------------------

def _cv_rmse_for_gamma(
    Xs: np.ndarray, y: np.ndarray, tscv: TimeSeriesSplit, gamma: float,
) -> float:
    """Median-quantile RMSE over folds for one gamma."""
    errs: list[float] = []
    for tr_idx, va_idx in tscv.split(Xs):
        X_tr, X_va = Xs[tr_idx], Xs[va_idx]
        y_tr, y_va = y[tr_idx], y[va_idx]
        try:
            sampler = RBFSampler(
                n_components=_N_COMPONENTS, gamma=gamma, random_state=_SEED,
            ).fit(X_tr)
            Z_tr = sampler.transform(X_tr)
            Z_va = sampler.transform(X_va)
            model = GradientBoostingRegressor(
                loss="quantile", alpha=0.5, **_GBR_PARAMS,
            ).fit(Z_tr, y_tr)
            pred = model.predict(Z_va)
            errs.append(float(np.sqrt(np.mean((y_va - pred) ** 2))))
        except Exception:
            continue
    if not errs:
        return float("inf")
    return float(np.mean(errs))


def _pick_gamma(Xs: np.ndarray, y: np.ndarray) -> float:
    """Pick the gamma with the lowest CV RMSE on the median-quantile head."""
    n_splits = min(3, max(2, len(Xs) // 60))
    tscv = TimeSeriesSplit(n_splits=n_splits)
    best_gamma = _GAMMAS[1]
    best_rmse = float("inf")
    for g in _GAMMAS:
        rmse = _cv_rmse_for_gamma(Xs, y, tscv, g)
        if np.isfinite(rmse) and rmse < best_rmse:
            best_rmse = rmse
            best_gamma = g
    return best_gamma


# --- model fit -------------------------------------------------------

def fit_rff_quantile_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> RFFQuantileNowcastModel:
    """Fit StandardScaler -> RBFSampler -> 3x quantile GBR on (X, y)."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values.astype(float)
    yv = y.values.astype(float)

    scaler = StandardScaler().fit(Xv)
    Xs = scaler.transform(Xv)

    gamma = _pick_gamma(Xs, yv)

    sampler = RBFSampler(
        n_components=_N_COMPONENTS, gamma=gamma, random_state=_SEED,
    ).fit(Xs)
    Z = sampler.transform(Xs)

    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Z, yv)
        models[q] = gbr

    return RFFQuantileNowcastModel(
        scaler=scaler,
        sampler=sampler,
        models=models,
        feature_cols=cols,
        gamma=gamma,
        as_of_day=as_of_day,
    )


# --- inference helpers ----------------------------------------------

def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Feature row for the cut, simulating as-of `as_of_day` of target month."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Convert predicted MoM log-% to YoY % via the standard chain logic."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


# --- public entry points --------------------------------------------

def run_rff_quantile_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> RFFQuantileNowcastResult:
    """Pull live panels, fit RFF+quantile model, produce a current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_rff_quantile_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return RFFQuantileNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_rff_quantile_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the RFF + quantile nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train on data strictly BEFORE t (StandardScaler -> RBFSampler ->
        three quantile GBRs at q in {0.1, 0.5, 0.9})
      - tune RBF gamma over {0.01, 0.05, 0.1} via internal TimeSeriesSplit
        on h=0 (median-quantile) RMSE
      - predict t's MoM, sort the triple for monotonicity, take median
      - clip to [-1.5, 2.5], chain to YoY against the actual published
        CPI from 12 months prior

    Bad cut -> skip via try/except. Return shape mirrors
    `nowcast.backtest_nowcast` exactly.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []
    last_as_of: pd.Timestamp | None = None

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            model = fit_rff_quantile_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day,
            )
            last_as_of = as_of

            pred_mom, _, _ = model.predict_one(pd.Series(feats))
            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(pred_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
            })
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts"}

    pm = np.array(preds_mom); am = np.array(actuals_mom)
    py = np.array(preds_yoy); ay = np.array(actuals_yoy)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_mom),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }
