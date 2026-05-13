"""Multi-as-of-day nowcaster: pick the right model for the day-of-month.

The baseline trains one quantile_rich model assuming as-of-day=20. But:
  - At day 5, you have noisy partial data → need a model that doesn't
    over-weight the daily signal.
  - At day 25-28, you have nearly the full month → daily features are
    near their final values; trust them more.

Solution: train SEPARATE quantile_rich models at as-of-days {15, 20, 25, 28}.
At inference, pick the closest match to today's date OR linearly interpolate
between flanking models.

For backtest with as_of_day=20, this should match quantile_rich. The win
shows up when running LIVE late in the month (day 25+) where we have more
signal than the day-20 model was trained for.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .nowcast import _build_supervised, _as_of_for_month, DEFAULT_AS_OF_DAY, NowcastResult
from .nowcast_features import features_at, build_daily_frame
from .nowcast_richfeats import rich_features_at, _build_supervised_rich
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel


CALIBRATION_DAYS = (15, 20, 25, 28)


def _train_at_day(panel, daily_frame, day: int):
    """Train q={0.1, 0.5, 0.9} GBR using rich features built at calibration day `d`."""
    X, y = _build_supervised_rich(panel, daily_frame, as_of_day=day)
    if len(X) < 24:
        return None
    models = []
    for q in (0.1, 0.5, 0.9):
        m = GradientBoostingRegressor(
            loss="quantile", alpha=q, n_estimators=300,
            max_depth=3, learning_rate=0.05, random_state=42,
        ).fit(X.values, y.values)
        models.append(m)
    return {"models": models, "feature_cols": list(X.columns), "X_median": X.median(numeric_only=True)}


def _predict_at_day(model_bundle, x_inf: pd.Series) -> tuple[float, float, float]:
    cols = model_bundle["feature_cols"]
    x = x_inf.reindex(cols).fillna(model_bundle["X_median"]).values.reshape(1, -1)
    preds = sorted(float(m.predict(x)[0]) for m in model_bundle["models"])
    lo, mid, hi = preds
    mid = float(np.clip(mid, -1.5, 2.5))
    return mid, lo, hi


def _pick_or_interp(bundles: dict, as_of_day: int, x_inf: pd.Series):
    """Pick closest day model, or interpolate between flanking days."""
    days = sorted(bundles.keys())
    if as_of_day in bundles:
        return _predict_at_day(bundles[as_of_day], x_inf)
    if as_of_day < days[0]:
        return _predict_at_day(bundles[days[0]], x_inf)
    if as_of_day > days[-1]:
        return _predict_at_day(bundles[days[-1]], x_inf)
    # Find flanking
    for i in range(len(days) - 1):
        d_lo, d_hi = days[i], days[i + 1]
        if d_lo <= as_of_day <= d_hi:
            mid_lo, lo_lo, hi_lo = _predict_at_day(bundles[d_lo], x_inf)
            mid_hi, lo_hi, hi_hi = _predict_at_day(bundles[d_hi], x_inf)
            w_hi = (as_of_day - d_lo) / (d_hi - d_lo)
            w_lo = 1 - w_hi
            return (
                w_lo * mid_lo + w_hi * mid_hi,
                w_lo * lo_lo + w_hi * lo_hi,
                w_lo * hi_lo + w_hi * hi_hi,
            )
    # Fallback (shouldn't hit)
    return _predict_at_day(bundles[days[0]], x_inf)


def backtest_multiday_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    cuts = list(range(len(y_mom) - window_months, len(y_mom)))

    rows = []
    pm_arr, am_arr, py_arr, ay_arr = [], [], [], []
    for ci in cuts:
        target_month_end = y_mom.index[ci]
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue
        # Train one model per calibration day on this train_panel
        bundles = {}
        for d in CALIBRATION_DAYS:
            try:
                b = _train_at_day(train_panel, daily_frame, d)
                if b is not None:
                    bundles[d] = b
            except Exception:
                continue
        if not bundles:
            continue

        # Build the inference feature row at the requested as_of_day
        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        ) if len(train_panel[TARGET.fred_id].dropna()) >= 13 else np.nan
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        x_inf = pd.Series(feats)

        try:
            mid, lo, hi = _pick_or_interp(bundles, as_of_day, x_inf)
        except Exception:
            continue

        actual_mom = float(y_mom.iloc[ci])
        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        pred_cpi = last_cpi_train * float(np.exp(mid / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (pred_cpi / denom - 1.0) * 100.0
        actual_cpi = float(cpi.loc[target_month_end])
        actual_yoy = (actual_cpi / denom - 1.0) * 100.0

        pm_arr.append(mid); am_arr.append(actual_mom)
        py_arr.append(pred_yoy); ay_arr.append(actual_yoy)
        rows.append({
            "target_month": target_month_end.strftime("%Y-%m"),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "pred_mom": round(mid, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(pred_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(pred_yoy - actual_yoy, 3),
        })

    if not pm_arr:
        return {"error": "no successful cuts"}

    pm = np.array(pm_arr); am = np.array(am_arr)
    py = np.array(py_arr); ay = np.array(ay_arr)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(pm),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }


def run_multiday_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    """Live nowcast: today's day determines as-of-day, pick closest model."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    bundles = {}
    for d in CALIBRATION_DAYS:
        b = _train_at_day(panel, daily_frame, d)
        if b is not None:
            bundles[d] = b
    if not bundles:
        raise RuntimeError("All calibration-day bundles failed to train")

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # Effective day = how many days into the target month we are.
    if as_of >= target_month_start:
        effective_day = (as_of - target_month_start).days + 1
    else:
        effective_day = as_of_day
    effective_day = max(1, min(31, effective_day))

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    x_inf = pd.Series(feats)

    mid, lo, hi = _pick_or_interp(bundles, effective_day, x_inf)

    last_cpi = float(cpi.iloc[-1])
    pred_cpi = last_cpi * float(np.exp(mid / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    yoy_mid = (pred_cpi / denom - 1.0) * 100.0
    yoy_lo = (last_cpi * float(np.exp(lo / 100.0)) / denom - 1.0) * 100.0
    yoy_hi = (last_cpi * float(np.exp(hi / 100.0)) / denom - 1.0) * 100.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=yoy_mid,
        lo80_yoy=yoy_lo,
        hi80_yoy=yoy_hi,
        days_observed=days_observed,
    )
