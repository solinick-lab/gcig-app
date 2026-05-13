"""Adaptive-by-day-of-month CPI nowcaster.

The baseline `nowcast.py` trains ONE model assuming the inference will
happen on day 20 of the target month. The within-month signal-to-noise
ratio, however, is fundamentally different at different points in the
month: by day 5 the partial features are mostly noise, by day 25 they
capture nearly the full month's price action.

This module trains a SEPARATE model for each as-of day in
{5, 10, 15, 20, 25}. At inference time, the requested as-of day is
served either by the closest model or by linear interpolation between
the two flanking models (weights inversely proportional to day distance).

The hypothesis is that a model trained on day-15 features knows those
features are partial, and a model trained on day-25 features trusts
them more. Use the right tool for the day.

Public API mirrors `nowcast`:
  - backtest_adaptive_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  - run_adaptive_nowcast(as_of_day=20)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

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


# Calibration days used to train the per-day model bank.
CALIBRATION_DAYS = (5, 10, 15, 20, 25)


@dataclass
class _PerDayModel:
    scaler: StandardScaler
    ridge: RidgeCV
    gbr: GradientBoostingRegressor
    feature_cols: list[str]
    resid_std: float
    as_of_day: int


def _fit_one(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> _PerDayModel | None:
    """Fit a (Ridge + GBR) ensemble for a single as-of-day."""
    try:
        X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    except Exception:
        return None
    if len(X) < 24 or X.shape[1] == 0:
        return None
    cols = list(X.columns)
    try:
        scaler = StandardScaler().fit(X.values)
        Xs = scaler.transform(X.values)
        ridge = RidgeCV(alphas=np.logspace(-3, 3, 25)).fit(Xs, y.values)
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=0.5, n_estimators=300,
            max_depth=3, learning_rate=0.05, random_state=42,
        ).fit(X.values, y.values)
        blend = (ridge.predict(Xs) + gbr.predict(X.values)) / 2.0
        resid = y.values - blend
        resid_std = float(np.std(resid))
    except Exception:
        return None
    return _PerDayModel(
        scaler=scaler, ridge=ridge, gbr=gbr,
        feature_cols=cols, resid_std=resid_std, as_of_day=as_of_day,
    )


def _fit_bank(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
) -> dict[int, _PerDayModel]:
    """Train one model per calibration day; skip days that fail."""
    bank: dict[int, _PerDayModel] = {}
    for d in CALIBRATION_DAYS:
        m = _fit_one(panel, daily_frame, as_of_day=d)
        if m is not None:
            bank[d] = m
    return bank


def _predict_one_model(model: _PerDayModel, x: pd.Series) -> tuple[float, float]:
    """Return (mean_pred, resid_std) for one feature vector against one model."""
    x_aligned = x.reindex(model.feature_cols).fillna(0.0).values.reshape(1, -1)
    x_s = model.scaler.transform(x_aligned)
    ridge_pred = float(model.ridge.predict(x_s)[0])
    gbr_pred = float(model.gbr.predict(x_aligned)[0])
    mean = (ridge_pred + gbr_pred) / 2.0
    return mean, model.resid_std


def _interpolate_predict(
    bank: dict[int, _PerDayModel],
    feats_by_day: dict[int, pd.Series],
    requested_day: int,
) -> tuple[float, float, float]:
    """Pick the closest model, or interpolate between the two flanking models.

    Each model is asked to predict on features built FOR ITS OWN as-of day —
    that's the whole point: a day-25 model expects day-25 features. If we
    don't have features at the model's calibration day, we fall back to the
    requested-day features.

    Weights are inversely proportional to |requested_day - calibration_day|.
    Returns (pred_mom, lo80, hi80) where lo/hi use the blended residual std.
    """
    if not bank:
        raise RuntimeError("no per-day models trained")

    days_sorted = sorted(bank.keys())

    # Exact / closest hit if we're outside the calibration range.
    if requested_day <= days_sorted[0]:
        d = days_sorted[0]
        feats = feats_by_day.get(d, feats_by_day.get(requested_day))
        mean, sd = _predict_one_model(bank[d], feats)
        z = 1.2816
        return mean, mean - z * sd, mean + z * sd
    if requested_day >= days_sorted[-1]:
        d = days_sorted[-1]
        feats = feats_by_day.get(d, feats_by_day.get(requested_day))
        mean, sd = _predict_one_model(bank[d], feats)
        z = 1.2816
        return mean, mean - z * sd, mean + z * sd

    # Find flanking calibration days.
    lo_day = max(d for d in days_sorted if d <= requested_day)
    hi_day = min(d for d in days_sorted if d >= requested_day)
    if lo_day == hi_day:
        feats = feats_by_day.get(lo_day, feats_by_day.get(requested_day))
        mean, sd = _predict_one_model(bank[lo_day], feats)
        z = 1.2816
        return mean, mean - z * sd, mean + z * sd

    span = float(hi_day - lo_day)
    # Inversely proportional to distance: closer day gets larger weight.
    w_hi = float(requested_day - lo_day) / span
    w_lo = float(hi_day - requested_day) / span

    feats_lo = feats_by_day.get(lo_day, feats_by_day.get(requested_day))
    feats_hi = feats_by_day.get(hi_day, feats_by_day.get(requested_day))
    mean_lo, sd_lo = _predict_one_model(bank[lo_day], feats_lo)
    mean_hi, sd_hi = _predict_one_model(bank[hi_day], feats_hi)

    mean = w_lo * mean_lo + w_hi * mean_hi
    # Blend residual variance, then back to std (independent-error approx).
    sd = float(np.sqrt(w_lo * sd_lo ** 2 + w_hi * sd_hi ** 2))
    z = 1.2816
    return mean, mean - z * sd, mean + z * sd


def _build_inference_feats(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> pd.Series:
    """Build the inference feature vector at a given day of the target month.

    Mirrors the lag/calendar augmentation done in `_build_supervised` and in
    `nowcast.backtest_nowcast`'s inference branch. Uses lag features sourced
    from `panel` (already trimmed by the caller for backtest contexts).
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


def backtest_adaptive_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the adaptive-by-day-of-month nowcaster.

    At each historical cut t:
      1. Train a bank of 5 models (one per day in {5,10,15,20,25}) on the
         data available before t.
      2. Build inference features at each calibration day of the target month.
      3. Pick the closest model (or interpolate between the two flanking ones)
         and predict.
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

            # Build features at each calibration day of the target month so
            # each model sees the partial signal it was trained on.
            feats_by_day: dict[int, pd.Series] = {}
            for d in bank.keys():
                feats_by_day[d] = _build_inference_feats(
                    train_panel, daily_frame, target_month_end, d
                )
            # Ensure the requested day has a feature vector even if it's not
            # one of the calibration days (used for fallback above the range).
            if as_of_day not in feats_by_day:
                feats_by_day[as_of_day] = _build_inference_feats(
                    train_panel, daily_frame, target_month_end, as_of_day
                )

            pred_mom, lo_mom, hi_mom = _interpolate_predict(
                bank, feats_by_day, requested_day=as_of_day
            )
            actual_mom = float(y_mom.iloc[ci])

            # YoY conversion (mirrors nowcast.backtest_nowcast).
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_cpi = last_cpi_train * float(np.exp(pred_mom / 100.0))
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            pred_yoy = (pred_cpi / denom - 1.0) * 100.0
            actual_cpi = float(cpi.loc[target_month_end])
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            # As-of day for reporting.
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
        "rows": rows,
    }


def run_adaptive_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    """Top-level adaptive nowcast: fetch panels, train per-day bank, predict
    the current month using the model bank picked/interpolated at `as_of_day`.
    """
    try:
        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)

        bank = _fit_bank(panel, daily_frame)
        if not bank:
            raise RuntimeError("failed to train any per-day model")

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

        last_cpi = float(cpi.iloc[-1])
        predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (predicted_cpi / denom - 1.0) * 100.0

        pred_cpi_lo = last_cpi * float(np.exp(lo_mom / 100.0))
        pred_cpi_hi = last_cpi * float(np.exp(hi_mom / 100.0))
        lo80_yoy = (pred_cpi_lo / denom - 1.0) * 100.0
        hi80_yoy = (pred_cpi_hi / denom - 1.0) * 100.0

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
        # Surface a structured fallback so callers don't crash; mirrors the
        # try/except contract requested by the deliverable.
        return NowcastResult(
            as_of=pd.Timestamp.utcnow().tz_localize(None).normalize(),
            target_month=str(e),
            pred_mom=float("nan"),
            pred_yoy=float("nan"),
            lo80_yoy=float("nan"),
            hi80_yoy=float("nan"),
            days_observed=0,
        )
