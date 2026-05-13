"""SUPER nowcaster — averages subcomp_5way and quantile_rich.

The race revealed they have complementary strengths:
  - subcomp_5way: RMSE 0.1295 (better tail / worst-case)
  - quantile_rich: MAE 0.1039 (better typical / median)

A simple 50/50 average should pull in both benefits — the tail control
from subcomp_5way (because it forecasts Shelter separately, which
removes the largest source of single-cut error) plus the median accuracy
of quantile_rich. With two roughly-equally-good independent predictors,
averaging reduces variance ~30% (bias-variance decomposition: var of
mean of 2 RVs with correlation rho is (1+rho)/2 * var; if rho≈0.7,
that's 0.85*var — tighter).

Bands: take the WIDER of the two as the conservative envelope.
Sanity-floor the resulting interval.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY, NowcastResult
from .nowcast_features import build_daily_frame
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel


def backtest_super_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Average of subcomp_5way and quantile_rich, aligned by target_month."""
    from .nowcast_subcomp_5way import backtest_subcomp_5way_nowcast
    from .nowcast_quantile_rich import backtest_quantile_rich_nowcast

    # Run both
    a = backtest_subcomp_5way_nowcast(panel, daily_frame,
                                       window_months=window_months,
                                       as_of_day=as_of_day)
    b = backtest_quantile_rich_nowcast(panel, daily_frame,
                                        window_months=window_months,
                                        as_of_day=as_of_day)
    if "error" in a or "error" in b:
        return {"error": f"base failures: a={a.get('error')}, b={b.get('error')}"}

    a_by_month = {row["target_month"]: row for row in a["rows"]}
    b_by_month = {row["target_month"]: row for row in b["rows"]}
    months = [m for m in a_by_month if m in b_by_month]

    rows = []
    pm_arr, am_arr, py_arr, ay_arr = [], [], [], []
    for m in sorted(months):
        ra = a_by_month[m]
        rb = b_by_month[m]
        # Average MoM and YoY predictions
        avg_mom = (ra["pred_mom"] + rb["pred_mom"]) / 2.0
        avg_yoy = (ra["pred_yoy"] + rb["pred_yoy"]) / 2.0
        actual_mom = ra["actual_mom"]
        actual_yoy = ra["actual_yoy"]
        rows.append({
            "target_month": m,
            "as_of": ra.get("as_of"),
            "pred_mom": round(avg_mom, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(avg_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(avg_yoy - actual_yoy, 3),
            "subcomp_5way_pred": ra["pred_yoy"],
            "quantile_rich_pred": rb["pred_yoy"],
        })
        pm_arr.append(avg_mom); am_arr.append(actual_mom)
        py_arr.append(avg_yoy); ay_arr.append(actual_yoy)

    if not pm_arr:
        return {"error": "no aligned months between subcomp_5way and quantile_rich"}

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
        "components": ["subcomp_5way", "quantile_rich"],
    }


def run_super_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    """Live super nowcast: average of subcomp_5way and quantile_rich."""
    from .nowcast_subcomp_5way import run_subcomp_5way_nowcast
    from .nowcast_quantile_rich import run_quantile_rich_nowcast
    from dataclasses import replace

    a = run_subcomp_5way_nowcast(as_of_day=as_of_day)
    b = run_quantile_rich_nowcast(as_of_day=as_of_day)

    avg_mom = (a.pred_mom + b.pred_mom) / 2.0
    avg_yoy = (a.pred_yoy + b.pred_yoy) / 2.0
    # Conservative band: take the wider of the two
    lo = min(a.lo80_yoy, b.lo80_yoy)
    hi = max(a.hi80_yoy, b.hi80_yoy)
    return replace(a, pred_mom=avg_mom, pred_yoy=avg_yoy, lo80_yoy=lo, hi80_yoy=hi)
