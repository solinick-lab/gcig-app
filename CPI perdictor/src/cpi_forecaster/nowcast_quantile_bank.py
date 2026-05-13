"""Day-of-month quantile-bank CPI nowcaster.

The pure-quantile `nowcast_quantile.py` trains ONE bank of three GBR
quantile heads (q={0.1, 0.5, 0.9}) assuming inference happens on day 20
of the target month. The adaptive-by-day variant in `nowcast_adaptive.py`
keeps a per-day Ridge+GBR-mean ensemble, but it ties everything to a
Gaussian residual interval and an L2/squared-error point forecast.

This module fuses both ideas: train a SEPARATE quantile bank
(q=0.1, 0.5, 0.9) for each calibration day in {5, 10, 15, 20, 25}.
At inference, the requested as-of day is served by the closest model
or by linearly interpolating between the two flanking models with
weights inversely proportional to day distance.

Day-5 features are mostly noise; day-25 features carry near-full
signal. A pinball-loss head trained at day 5 learns to lean on the
priors (lags, calendar) more aggressively, while the day-25 head
trusts within-month features. The hypothesis is that quantile loss
on top of the day-of-month bank does better than tied baselines.

Public API mirrors the standard nowcast interface:
  - backtest_quantile_bank_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  - run_quantile_bank_nowcast(as_of_day=20) -> NowcastResult

Under <60s/cut: the GBR per-quantile fits are kept light
(n_estimators=300 each, depth 3), and one bad cut/fit doesn't tank
the whole walk-forward via try/except guards.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import (
    DEFAULT_AS_OF_DAY,
    NowcastResult,
    _as_of_for_month,
    _build_supervised,
)
from .nowcast_features import build_daily_frame, features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

CALIBRATION_DAYS = (5, 10, 15, 20, 25)

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval to avoid collapse

# Lighter than the single-bank quantile module so that the 5-day fan-out
# (5 days * 3 quantiles = 15 GBRs per cut) keeps under 60s/cut.
_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class _PerDayQuantileModel:
    """Three quantile-loss GBRs for a single calibration day."""
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]
    as_of_day: int


def _fit_one_day(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> _PerDayQuantileModel | None:
    """Fit q={0.1, 0.5, 0.9} GBRs for one calibration day. None on failure."""
    try:
        X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    except Exception:
        return None
    if len(X) < 24 or X.shape[1] == 0:
        return None
    cols = list(X.columns)
    Xv = X.values
    yv = y.values
    try:
        models: dict[float, GradientBoostingRegressor] = {}
        for q in _QUANTILES:
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=q, **_GBR_PARAMS,
            ).fit(Xv, yv)
            models[q] = gbr
    except Exception:
        return None
    return _PerDayQuantileModel(
        models=models, feature_cols=cols, as_of_day=as_of_day,
    )


def _fit_bank(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
) -> dict[int, _PerDayQuantileModel]:
    """Fit one quantile-triple per calibration day; skip days that fail."""
    bank: dict[int, _PerDayQuantileModel] = {}
    for d in CALIBRATION_DAYS:
        m = _fit_one_day(panel, daily_frame, as_of_day=d)
        if m is not None:
            bank[d] = m
    return bank


def _predict_one_model(
    model: _PerDayQuantileModel, x: pd.Series
) -> tuple[float, float, float]:
    """Predict (q0.1, q0.5, q0.9) for one feature row against one day's bank.

    Returns the RAW (un-sorted) triple — sort/clip is done after blending
    so the interpolation between days is preserved per quantile.
    """
    x_aligned = x.reindex(model.feature_cols).fillna(0.0).values.reshape(1, -1)
    q10 = float(model.models[0.1].predict(x_aligned)[0])
    q50 = float(model.models[0.5].predict(x_aligned)[0])
    q90 = float(model.models[0.9].predict(x_aligned)[0])
    return q10, q50, q90


def _interpolate_predict(
    bank: dict[int, _PerDayQuantileModel],
    feats_by_day: dict[int, pd.Series],
    requested_day: int,
) -> tuple[float, float, float]:
    """Pick the closest day's model, or interpolate between flanking days.

    Each model is fed features built FOR ITS OWN calibration day — a
    day-25 model expects day-25 features. Weights are inversely
    proportional to |requested_day - calibration_day|, like the adaptive
    Ridge+GBR variant.

    Returns (pred_mom_median, lo10, hi90) AFTER sorting (to enforce
    monotonicity post quantile-crossing) but BEFORE clipping to the
    [-1.5, 2.5] MoM band.
    """
    if not bank:
        raise RuntimeError("no per-day quantile models trained")

    days_sorted = sorted(bank.keys())

    # Outside calibration range — clamp to the nearest day.
    if requested_day <= days_sorted[0]:
        d = days_sorted[0]
        feats = feats_by_day.get(d, feats_by_day.get(requested_day))
        q10, q50, q90 = _predict_one_model(bank[d], feats)
    elif requested_day >= days_sorted[-1]:
        d = days_sorted[-1]
        feats = feats_by_day.get(d, feats_by_day.get(requested_day))
        q10, q50, q90 = _predict_one_model(bank[d], feats)
    else:
        # Find flanking calibration days.
        lo_day = max(d for d in days_sorted if d <= requested_day)
        hi_day = min(d for d in days_sorted if d >= requested_day)
        if lo_day == hi_day:
            feats = feats_by_day.get(lo_day, feats_by_day.get(requested_day))
            q10, q50, q90 = _predict_one_model(bank[lo_day], feats)
        else:
            span = float(hi_day - lo_day)
            # Inversely proportional to distance: closer day -> larger weight.
            w_hi = float(requested_day - lo_day) / span
            w_lo = float(hi_day - requested_day) / span

            feats_lo = feats_by_day.get(lo_day, feats_by_day.get(requested_day))
            feats_hi = feats_by_day.get(hi_day, feats_by_day.get(requested_day))
            q10_l, q50_l, q90_l = _predict_one_model(bank[lo_day], feats_lo)
            q10_h, q50_h, q90_h = _predict_one_model(bank[hi_day], feats_hi)

            q10 = w_lo * q10_l + w_hi * q10_h
            q50 = w_lo * q50_l + w_hi * q50_h
            q90 = w_lo * q90_l + w_hi * q90_h

    # Sort to enforce monotonicity in case of quantile crossing.
    triple = np.sort(np.array([q10, q50, q90], dtype=float))
    return float(triple[1]), float(triple[0]), float(triple[2])


def _build_inference_feats(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> pd.Series:
    """Build the inference feature row at a given as-of day of the target month.

    Mirrors the lag/calendar augmentation used in `_build_supervised` and
    in `nowcast.backtest_nowcast`. The caller is responsible for trimming
    `panel` to data strictly before the target month for backtest cuts.
    """
    cpi = panel[TARGET.fred_id].dropna()
    train_y = build_target(panel).dropna()
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float(
        (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
    ) if len(cpi) >= 13 else np.nan
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return pd.Series(feats)


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Convert MoM log-% to YoY % using last_cpi * exp(mom/100) chained
    against the CPI level 12 months before target_month."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


def backtest_quantile_bank_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the day-of-month quantile-bank nowcaster.

    For each historical cut t in the trailing `window_months`:
      1. Build a bank of per-day quantile triples (q={0.1, 0.5, 0.9})
         for each calibration day, using only data strictly BEFORE t.
      2. For each calibration day, build an inference feature row
         AT THAT DAY of the target month (so each model sees the
         partial signal it was trained on).
      3. Pick the closest model to `as_of_day`, or linearly interpolate
         between the two flanking models. Sort the resulting q10/q50/q90.
      4. Clip the median MoM to [-1.5, 2.5] and chain to YoY against the
         actual published CPI from 12 months before target_month.

    Single-cut failures are swallowed via try/except so a thin training
    history doesn't tank the whole walk-forward window.
    """
    try:
        cpi = panel[TARGET.fred_id].dropna()
        y_mom = build_target(panel).dropna()
    except Exception as e:
        return {"error": f"failed to build target: {e}"}

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

            bank = _fit_bank(train_panel, daily_frame)
            if not bank:
                continue

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            # Build features at each calibration day so each model sees
            # the partial signal it was trained on.
            feats_by_day: dict[int, pd.Series] = {}
            for d in bank.keys():
                feats_by_day[d] = _build_inference_feats(
                    train_panel, daily_frame, target_month_end, d
                )
            if as_of_day not in feats_by_day:
                feats_by_day[as_of_day] = _build_inference_feats(
                    train_panel, daily_frame, target_month_end, as_of_day
                )

            pred_mom, _lo_mom, _hi_mom = _interpolate_predict(
                bank, feats_by_day, requested_day=as_of_day
            )
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

            # As-of timestamp for reporting.
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of_ts = _as_of_for_month(m_start, as_of_day)

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of_ts.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "modelsUsed": sorted(bank.keys()),
            })
        except Exception:
            # One bad cut shouldn't tank the whole backtest.
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
        "calibrationDays": list(CALIBRATION_DAYS),
        "quantiles": list(_QUANTILES),
        "rows": rows,
    }


def run_quantile_bank_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    """Top-level: fetch panels, fit a per-day quantile bank, and produce a
    current-month forecast at the requested as-of day (closest-model or
    interpolation between flanking calibration days).
    """
    try:
        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)

        bank = _fit_bank(panel, daily_frame)
        if not bank:
            raise RuntimeError("failed to train any per-day quantile model")

        today = pd.Timestamp.utcnow().tz_localize(None).normalize()
        cpi = panel[TARGET.fred_id].dropna()
        last_released_month_end = cpi.index[-1]
        target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
        target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

        as_of = min(today, target_month_end)
        if today < target_month_start:
            as_of = _as_of_for_month(target_month_start, as_of_day)

        # Build features at each calibration day for the target month.
        feats_by_day: dict[int, pd.Series] = {}
        for d in bank.keys():
            feats_by_day[d] = _build_inference_feats(
                panel, daily_frame, target_month_end, d
            )
        if as_of_day not in feats_by_day:
            feats_by_day[as_of_day] = _build_inference_feats(
                panel, daily_frame, target_month_end, as_of_day
            )

        pred_mom, lo_mom, hi_mom = _interpolate_predict(
            bank, feats_by_day, requested_day=as_of_day
        )
        pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

        last_cpi = float(cpi.iloc[-1])
        pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
        lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
        hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

        # Floor the half-widths so a tight quantile fit doesn't collapse the band.
        if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
            hi80_yoy = pred_yoy + _RESID_FLOOR
        if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
            lo80_yoy = pred_yoy - _RESID_FLOOR

        days_observed = sum(
            1 for s in daily_frame.values()
            if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
        )

        return NowcastResult(
            as_of=as_of,
            target_month=target_month_end.strftime("%Y-%m"),
            pred_mom=pred_mom,
            pred_yoy=pred_yoy,
            lo80_yoy=lo80_yoy,
            hi80_yoy=hi80_yoy,
            days_observed=days_observed,
        )
    except Exception as e:
        # Surface a structured fallback so callers don't crash.
        return NowcastResult(
            as_of=pd.Timestamp.utcnow().tz_localize(None).normalize(),
            target_month=str(e),
            pred_mom=float("nan"),
            pred_yoy=float("nan"),
            lo80_yoy=float("nan"),
            hi80_yoy=float("nan"),
            days_observed=0,
        )
