"""Polynomial-feature nowcaster (interaction-only) over Yellen 1.1's feature set.

Idea: Yellen 1.1 (clev_calibrated) tops out near 0.1142 RMSE with a
gradient-boosted quantile stack on a rich numeric feature set including
the Cleveland Fed nowcast columns. Tree ensembles already capture
single-feature non-linearities reasonably well, but they do so locally
and rarely express *crossing* interactions cleanly (e.g.
clev_yoy * cpi_mom_lag1 — a 'momentum vs nowcast' interaction).

A heavily regularized linear model on degree-2 INTERACTION-ONLY
polynomial features is a different bias / variance tradeoff: it
explicitly searches a larger LINEAR-in-coefficients hypothesis space
that includes all pairwise interactions but no squared terms (which
keeps the column blow-up manageable: n=30 -> ~465 columns instead of
~496 for full degree-2). RidgeCV picks alpha by leave-one-out CV across
a wide grid so no manual tuning is needed.

Pipeline:
   StandardScaler  ->  PolynomialFeatures(degree=2, interaction_only=True)
                   ->  RidgeCV(alphas=[1, 3, 10, 30, 100, 300, 1000, 3000])

Strong shrinkage (median selected alpha typically lands in the 30-300
range during backtest, reflecting the high feature-to-row ratio) keeps
out-of-sample variance under control.

Public API (matches sibling nowcasters):
   backtest_poly_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
   run_poly_nowcast(as_of_day=20) -> PolyNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5]. 80% bands
come from the empirical training residual distribution (10/90 quantiles),
floored to 5 bps so degenerate residual fits don't produce zero-width
bands.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

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

# Wide alpha grid spanning ~3 orders of magnitude. RidgeCV does
# leave-one-out CV by default which is cheap on n~150 rows and gives a
# stable per-cut alpha pick.
_RIDGE_ALPHAS: tuple[float, ...] = (1.0, 3.0, 10.0, 30.0, 100.0, 300.0, 1000.0, 3000.0)

# Quantile floor / ceiling for empirical-residual band construction.
_RESID_QLO = 0.10
_RESID_QHI = 0.90


@dataclass
class PolyNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    ridge_alpha: float
    n_features_in: int
    n_features_poly: int


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def _make_pipeline() -> Pipeline:
    """Standardize -> degree-2 interaction-only -> RidgeCV."""
    return Pipeline(steps=[
        ("scaler", StandardScaler(with_mean=True, with_std=True)),
        ("poly", PolynomialFeatures(
            degree=2,
            interaction_only=True,
            include_bias=False,
        )),
        ("ridge", RidgeCV(alphas=_RIDGE_ALPHAS, fit_intercept=True)),
    ])


def _fit_pipeline(X: pd.DataFrame, y: pd.Series) -> Pipeline:
    pipe = _make_pipeline()
    pipe.fit(X.values, y.values)
    return pipe


def _residual_band(
    pipe: Pipeline, X: pd.DataFrame, y: pd.Series,
) -> tuple[float, float]:
    """Empirical 10/90 residual quantiles on the training set.

    Returns (lo_resid, hi_resid) in MoM space. These are SIGNED — lo is
    typically negative, hi positive. We use them as additive offsets to
    the point prediction to construct the 80% band.
    """
    try:
        in_sample = pipe.predict(X.values)
        resid = y.values - in_sample
        if len(resid) < 5:
            return -_RESID_FLOOR, _RESID_FLOOR
        lo = float(np.quantile(resid, _RESID_QLO))
        hi = float(np.quantile(resid, _RESID_QHI))
        # Floor so degenerate fits never produce zero-width bands
        if hi - lo < 2 * _RESID_FLOOR:
            mid = (hi + lo) / 2.0
            lo = mid - _RESID_FLOOR
            hi = mid + _RESID_FLOOR
        return lo, hi
    except Exception:
        return -_RESID_FLOOR, _RESID_FLOOR


def _predict_with_band(
    pipe: Pipeline, x_inf: pd.Series, cols: list[str],
    lo_resid: float, hi_resid: float,
) -> tuple[float, float, float]:
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    mid = float(pipe.predict(aligned)[0])
    return mid, mid + lo_resid, mid + hi_resid


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_poly_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the polynomial-feature nowcaster.

    For each cut: train on history strictly before `target_month_end`,
    fit StandardScaler + PolynomialFeatures(interaction_only) + RidgeCV,
    predict the held-out month. Cleveland scrape is fetched ONCE up
    front (its historical archive covers all cuts). Each cut is wrapped
    in try/except so a single failure cannot break the run.
    """
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
    alphas_seen: list[float] = []

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

            pipe = _fit_pipeline(X, y)
            cols = list(X.columns)
            lo_resid, hi_resid = _residual_band(pipe, X, y)
            try:
                ridge = pipe.named_steps["ridge"]
                alphas_seen.append(float(ridge.alpha_))
            except Exception:
                pass

            # --- inference features (same construction as Yellen 1.1) ----
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            mid, lo_mom, hi_mom = _predict_with_band(
                pipe, x_inf, cols, lo_resid, hi_resid,
            )
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi)
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
                "ridge_alpha": (
                    round(float(pipe.named_steps["ridge"].alpha_), 2)
                    if "ridge" in pipe.named_steps else None
                ),
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
        "medianRidgeAlpha": (
            float(np.median(alphas_seen)) if alphas_seen else None
        ),
        "rows": rows,
    }


def run_poly_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> PolyNowcastResult:
    """Live nowcast using StandardScaler + PolynomialFeatures + RidgeCV."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    pipe = _fit_pipeline(X, y)
    cols = list(X.columns)
    lo_resid, hi_resid = _residual_band(pipe, X, y)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
    mid, lo_mom, hi_mom = _predict_with_band(pipe, x_inf, cols, lo_resid, hi_resid)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
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

    # Diagnostics (best-effort — never raise)
    try:
        ridge_alpha = float(pipe.named_steps["ridge"].alpha_)
    except Exception:
        ridge_alpha = float("nan")
    try:
        n_in = int(X.shape[1])
        # PolynomialFeatures stores n_output_features_ after fit
        poly = pipe.named_steps["poly"]
        n_poly = int(getattr(poly, "n_output_features_", 0))
    except Exception:
        n_in = int(X.shape[1])
        n_poly = 0

    return PolyNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        ridge_alpha=ridge_alpha,
        n_features_in=n_in,
        n_features_poly=n_poly,
    )
