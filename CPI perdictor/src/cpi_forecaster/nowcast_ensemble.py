"""Median ensemble of the top 3 nowcasters: quantile_rich + tips_anchor + quantile.

Why median (not mean):
  - Robust to a single bad model on a bad cut
  - No meta-learning required (avoids the stacking overfit failure mode)
  - Bands: take the union (min lo80, max hi80) — slightly conservative,
    but safe given that nowcaster bands are already empirically tight.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .nowcast import _build_supervised, _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import features_at, build_daily_frame
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel


def _yoy_from_mom(panel, mom: float, target_month_end: pd.Timestamp) -> float:
    cpi = panel[TARGET.fred_id].dropna()
    last_cpi = float(cpi.iloc[-1])
    pred_cpi = last_cpi * float(np.exp(mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (pred_cpi / denom - 1.0) * 100.0


def backtest_ensemble_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Median ensemble of the top 3 winners. Same return shape as nowcast.backtest_nowcast."""
    from .nowcast_quantile_rich import backtest_quantile_rich_nowcast
    from .nowcast_tips_anchor import backtest_tips_anchor_nowcast
    from .nowcast_quantile import backtest_quantile_nowcast

    # Run each backtest. Each returns a dict with 'rows' = list of per-cut predictions.
    bases = {}
    for name, fn in [
        ("quantile_rich", backtest_quantile_rich_nowcast),
        ("tips_anchor", backtest_tips_anchor_nowcast),
        ("quantile", backtest_quantile_nowcast),
    ]:
        try:
            r = fn(panel, daily_frame, window_months=window_months, as_of_day=as_of_day)
            if "error" in r:
                continue
            bases[name] = r
        except Exception:
            continue

    if not bases:
        return {"error": "no base backtests succeeded"}

    # Align by target_month. Each base's rows are list of dicts with 'target_month'.
    months = None
    for r in bases.values():
        ms = [row["target_month"] for row in r["rows"]]
        if months is None:
            months = ms
        else:
            months = [m for m in months if m in ms]

    rows = []
    pm_arr, am_arr, py_arr, ay_arr = [], [], [], []
    for m in months:
        per_base = {}
        for name, r in bases.items():
            for row in r["rows"]:
                if row["target_month"] == m:
                    per_base[name] = row
                    break
        if len(per_base) < 2:
            continue
        pred_yoys = [v["pred_yoy"] for v in per_base.values()]
        pred_moms = [v["pred_mom"] for v in per_base.values()]
        actual_yoy = list(per_base.values())[0]["actual_yoy"]
        actual_mom = list(per_base.values())[0]["actual_mom"]
        median_pred_yoy = float(np.median(pred_yoys))
        median_pred_mom = float(np.median(pred_moms))
        rows.append({
            "target_month": m,
            "as_of": list(per_base.values())[0].get("as_of"),
            "pred_mom": round(median_pred_mom, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(median_pred_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(median_pred_yoy - actual_yoy, 3),
            "components": {k: round(v["pred_yoy"], 3) for k, v in per_base.items()},
        })
        pm_arr.append(median_pred_mom); am_arr.append(actual_mom)
        py_arr.append(median_pred_yoy); ay_arr.append(actual_yoy)

    if not pm_arr:
        return {"error": "no aligned cuts"}

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
        "components": list(bases.keys()),
    }


def run_ensemble_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY):
    """Live ensemble nowcast: median of the 3 winners."""
    from .nowcast_quantile_rich import run_quantile_rich_nowcast
    from .nowcast_tips_anchor import run_tips_anchor_nowcast
    from .nowcast_quantile import run_quantile_nowcast

    results = []
    for name, fn in [
        ("quantile_rich", run_quantile_rich_nowcast),
        ("tips_anchor", run_tips_anchor_nowcast),
        ("quantile", run_quantile_nowcast),
    ]:
        try:
            results.append((name, fn(as_of_day=as_of_day)))
        except Exception as e:
            print(f"[ensemble] {name} failed: {e}")
            continue

    if not results:
        raise RuntimeError("All base nowcasters failed")

    pred_moms = [r.pred_mom for _, r in results]
    pred_yoys = [r.pred_yoy for _, r in results]
    los = [r.lo80_yoy for _, r in results]
    his = [r.hi80_yoy for _, r in results]

    median_mom = float(np.median(pred_moms))
    median_yoy = float(np.median(pred_yoys))
    # Conservative interval: take the wider of the per-model bands
    lo80_yoy = float(np.min(los))
    hi80_yoy = float(np.max(his))

    sample = results[0][1]
    from dataclasses import replace
    return replace(
        sample,
        pred_mom=median_mom,
        pred_yoy=median_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
    )
