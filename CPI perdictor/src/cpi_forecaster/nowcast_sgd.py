"""SGDRegressor (Huber loss) nowcaster.

Hypothesis: a Huber-loss linear model trained via stochastic gradient
descent provides an alternative robust regression path to the closed-form
HuberRegressor IRLS solver. SGD with Huber loss minimises the same
piecewise-quadratic-then-linear objective but uses iterative gradient
updates with L2 regularisation (`alpha`), which acts as a smoother shrinker
than HuberRegressor's tiny `alpha=1e-4`. With a moderately small epsilon
(0.1) the loss transitions to absolute-deviation behavior earlier, further
attenuating the influence of COVID-era and energy-spike outliers on the
fitted hyperplane.

Approach:
  1. Reuse Yellen 1.1's feature matrix via `_build_supervised_clev`
     (Cleveland scrape integration, lagged CPI, daily-derived features).
  2. Standardize features (StandardScaler) — SGD is highly scale-sensitive
     because the gradient step size is shared across coordinates.
  3. Fit `SGDRegressor(loss='huber', epsilon=0.1, alpha=0.001,
     max_iter=2000)` with a fixed `random_state` for reproducibility.
  4. Point prediction = SGDRegressor.predict(x_inf), clipped to
     [-1.5, 2.5] MoM.
  5. 80% bands: in-sample residual std times z=1.2816 (Φ⁻¹(0.90)).

Public API (mirrors `nowcast.backtest_nowcast` / `run_nowcast`):
  backtest_sgd_nowcast(panel, daily_frame, window_months=24,
                       as_of_day=20) -> dict
  run_sgd_nowcast(as_of_day=20) -> SGDNowcastResult

Same return-dict keys as nowcast.backtest_nowcast: rmseMom, rmseYoy,
maeYoy, hitWithin25bp, hitWithin50bp, totalCuts, asOfDay, windowMonths,
rows. Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import SGDRegressor
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_SGD_LOSS = "huber"
_SGD_EPSILON = 0.1          # Huber loss switch point in standardized residual units
_SGD_ALPHA = 0.001          # L2 regularisation strength
_SGD_MAX_ITER = 2000        # SGD epoch budget
_SGD_TOL = 1e-4             # convergence tolerance
_SGD_RANDOM_STATE = 0       # reproducibility — SGD is stochastic
_BAND_Z = 1.2816            # one-sided z for 80% interval (Phi^-1(0.90))


@dataclass
class SGDNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    resid_sigma_mom: float


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_sgd(
    X: pd.DataFrame, y: pd.Series,
) -> tuple[StandardScaler, SGDRegressor]:
    """Standardize features then fit SGDRegressor with Huber loss.

    SGDRegressor's coordinate-uniform gradient step makes it very scale
    sensitive — features with larger raw scales dominate the loss
    surface. StandardScaler (mean=0, std=1) puts every feature on equal
    footing so `alpha` regularises uniformly across columns.
    """
    scaler = StandardScaler()
    Xs = scaler.fit_transform(X.values)
    sgd = SGDRegressor(
        loss=_SGD_LOSS,
        epsilon=_SGD_EPSILON,
        alpha=_SGD_ALPHA,
        max_iter=_SGD_MAX_ITER,
        tol=_SGD_TOL,
        fit_intercept=True,
        random_state=_SGD_RANDOM_STATE,
    )
    sgd.fit(Xs, y.values)
    return scaler, sgd


def _residual_band_sigma(
    sgd: SGDRegressor,
    Xs: np.ndarray,
    y: np.ndarray,
) -> float:
    """Std of in-sample residuals — used to size the 80% band."""
    preds = sgd.predict(Xs)
    resid = y - preds
    if len(resid) < 2:
        return 0.0
    sigma = float(np.std(resid, ddof=1))
    if not np.isfinite(sigma):
        sigma = 0.0
    return sigma


def _predict_sgd(
    scaler: StandardScaler,
    sgd: SGDRegressor,
    x_inf: pd.Series,
) -> float:
    Xs = scaler.transform(x_inf.values.reshape(1, -1))
    return float(sgd.predict(Xs)[0])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_sgd_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Yellen 1.1 features + SGDRegressor(Huber)."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            scaler, sgd = _fit_sgd(X, y)
            cols = list(X.columns)

            sigma = _residual_band_sigma(
                sgd, scaler.transform(X.values), y.values,
            )

            # Inference features (same recipe as Yellen 1.1).
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = (
                float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            )
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0)
                * 100.0
            )
            feats["month_sin"] = float(
                np.sin(2 * np.pi * target_month_end.month / 12.0)
            )
            feats["month_cos"] = float(
                np.cos(2 * np.pi * target_month_end.month / 12.0)
            )
            try:
                feats.update(
                    _clev_features_for_month(clev, target_month_end, panel)
                )
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(
                X.median(numeric_only=True)
            ).fillna(0.0)

            mid = _predict_sgd(scaler, sgd, x_inf)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            band = _BAND_Z * sigma
            lo = mid - band
            hi = mid + band

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
            pred_yoy = _mom_to_yoy(
                mid, last_cpi_train, target_month_end, cpi,
            )
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "lo_mom": round(lo, 4),
                "hi_mom": round(hi, 4),
                "resid_sigma": round(sigma, 4),
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
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_sgd_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SGDNowcastResult:
    """Live nowcast using Yellen 1.1 features + SGDRegressor(Huber)."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(
        panel, daily_frame, clev, as_of_day=as_of_day,
    )
    scaler, sgd = _fit_sgd(X, y)
    cols = list(X.columns)
    sigma = _residual_band_sigma(
        sgd, scaler.transform(X.values), y.values,
    )

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(
        np.sin(2 * np.pi * target_month_end.month / 12.0)
    )
    feats["month_cos"] = float(
        np.cos(2 * np.pi * target_month_end.month / 12.0)
    )
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(
        X.median(numeric_only=True)
    ).fillna(0.0)
    mid = _predict_sgd(scaler, sgd, x_inf)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
    band = _BAND_Z * sigma
    lo = mid - band
    hi = mid + band

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(
            s.loc[(s.index >= target_month_start) & (s.index <= as_of)]
        ) > 0
    )
    return SGDNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        resid_sigma_mom=sigma,
    )
