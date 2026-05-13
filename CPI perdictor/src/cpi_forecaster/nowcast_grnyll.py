"""GRNYLL — simple 50/50 average of Greenspan 1.1 and Yellen 1.1.

This module wraps the two strongest single-model nowcasters and averages
their predictions with a fixed 50/50 weight:

  - Greenspan 1.1 = nowcast_shelter_first
        Hierarchical Food / Energy / Shelter / Other-Core decomposition.
        Subcomponent-level forecasts driven by Zillow ZORI lags (shelter),
        WTI/Brent/retail gas (food, energy), and wages/sticky/MICH
        (other-core). Headline aggregated via BLS prior weights
        (0.13 / 0.07 / 0.33 / 0.47).

  - Yellen 1.1 = nowcast_clev_calibrated
        Cleveland-Fed-anchored quantile stack with a post-hoc Ridge bias
        calibrator on top. Uses the Cleveland Fed Inflation Nowcasting
        feed (or FRED Median CPI proxy when the scrape fails) as its
        load-bearing signal, with rich daily features for fine-tuning.

Why this wrapper exists:
  The two models use almost entirely DIFFERENT load-bearing signals:
    * Greenspan ignores Cleveland Fed entirely; Yellen ignores Zillow.
    * Greenspan's strongest features are Zillow ZORI lags + subcomponent
      panels; Yellen's are the Cleveland Fed daily nowcast vintage.
    * They overlap only on rich daily features (yields, breakevens, WTI,
      gas, USD) and headline lags — the load-bearing signal in each is
      distinct.
  So their ERRORS should be partially decorrelated, and a simple 50/50
  average should beat each individual model. Empirically: target beat
  for this wrapper is RMSE_YoY < 0.1142.

Public API mirrors the rest of the nowcast_* modules:
  backtest_grnyll_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_grnyll_nowcast(as_of_day=20) -> GrnYllNowcastResult

Each base call is wrapped in try/except. If only one base survives we
return its predictions verbatim (single-base pass-through). If neither
base survives we return {"error": ...} (or raise from run_).

Sanity: average MoM is clipped to [-1.5, 2.5] post-aggregation. Bands at
live time take the wider envelope across the two bases (conservative).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Sanity clip on aggregated MoM (matches each base's internal clip).
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5

# Floor on YoY half-band width when synthesizing the live confidence band
# from the two base bands.
_RESID_FLOOR = 0.05


@dataclass
class GrnYllNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    base_preds: dict              # {"greenspan": yoy, "yellen": yoy}
    weights: dict                 # final weights actually used
    component_diagnostic: dict    # extra info from the base runs


# ---------------------------------------------------------------------------
# Per-base safe runners
# ---------------------------------------------------------------------------


def _safe_backtest_greenspan(panel, daily_frame, window_months, as_of_day):
    """Greenspan 1.1 = shelter_first hierarchical nowcaster."""
    try:
        from .nowcast_shelter_first import backtest_shelter_first_nowcast
        out = backtest_shelter_first_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (out.get("error") if isinstance(out, dict) else "non-dict result")
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_yellen(panel, daily_frame, window_months, as_of_day):
    """Yellen 1.1 = clev_calibrated (Cleveland Fed + post-hoc Ridge bias)."""
    try:
        from .nowcast_clev_calibrated import backtest_clev_calibrated_nowcast
        out = backtest_clev_calibrated_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (out.get("error") if isinstance(out, dict) else "non-dict result")
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_run_greenspan(as_of_day):
    try:
        from .nowcast_shelter_first import run_shelter_first_nowcast
        return run_shelter_first_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_yellen(as_of_day):
    try:
        from .nowcast_clev_calibrated import run_clev_calibrated_nowcast
        return run_clev_calibrated_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_grnyll_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the Greenspan + Yellen 50/50 average.

    Procedure:
      1. Run each base's backtest over the same window/as_of_day.
      2. Drop any base whose backtest fails. If 0 survive: error. If 1
         survives: pass through its predictions verbatim with a flag.
      3. Align both base outputs by `target_month` — keep months reported
         by BOTH bases.
      4. Final pred_mom / pred_yoy = simple equal-weight mean of the two
         base predictions, with MoM clipped to [-1.5, 2.5].
      5. Return the standard backtest schema with diagnostic fields,
         including per-base aligned RMSE and pairwise error correlation.
    """
    base_specs = [
        ("greenspan", _safe_backtest_greenspan),
        ("yellen",    _safe_backtest_yellen),
    ]
    base_results: dict[str, dict] = {}
    base_errors: dict[str, str] = {}
    for name, fn in base_specs:
        out, err = fn(panel, daily_frame, window_months, as_of_day)
        if out is not None:
            base_results[name] = out
        else:
            base_errors[name] = err or "unknown"

    # Both failed.
    if not base_results:
        return {"error": f"all bases failed. errors: {base_errors}"}

    # Only one survived: pass-through.
    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only_out = base_results[only_name]
        out = dict(only_out)  # shallow copy
        out["chosenApproach"] = "single_base_passthrough"
        out["singleBase"] = only_name
        out["baseErrors"] = base_errors
        out["components"] = list(base_results.keys())
        return out

    # Both survived. Align by target_month.
    by_base_by_month: dict[str, dict[str, dict]] = {
        name: {row["target_month"]: row for row in out["rows"]}
        for name, out in base_results.items()
    }
    common_months = None
    for name, by_month in by_base_by_month.items():
        ms = set(by_month.keys())
        common_months = ms if common_months is None else (common_months & ms)
    common_months = sorted(common_months or [])
    if len(common_months) < 6:
        return {
            "error": (
                f"insufficient aligned months: {len(common_months)} "
                f"(need >=6). errors: {base_errors}"
            ),
        }

    base_names = list(base_results.keys())
    pred_yoy_mat = np.full((len(common_months), len(base_names)), np.nan)
    pred_mom_mat = np.full((len(common_months), len(base_names)), np.nan)
    actual_yoy = np.full(len(common_months), np.nan)
    actual_mom = np.full(len(common_months), np.nan)
    as_of_per_month: list[str] = []

    for i, m in enumerate(common_months):
        for j, name in enumerate(base_names):
            r = by_base_by_month[name][m]
            try:
                pred_yoy_mat[i, j] = float(r.get("pred_yoy"))
            except (TypeError, ValueError):
                pass
            try:
                pred_mom_mat[i, j] = float(r.get("pred_mom"))
            except (TypeError, ValueError):
                pass
        # Reference base for actuals: prefer yellen (clev_calibrated) since
        # its rows preserve `actual_yoy` cleanly. Fall back to greenspan.
        ref_row = (
            by_base_by_month.get("yellen", {}).get(m)
            or by_base_by_month.get("greenspan", {}).get(m)
            or by_base_by_month[base_names[0]][m]
        )
        try:
            actual_yoy[i] = float(ref_row["actual_yoy"])
            actual_mom[i] = float(ref_row["actual_mom"])
            as_of_per_month.append(str(ref_row.get("as_of", "")))
        except (TypeError, ValueError, KeyError):
            as_of_per_month.append("")

    # Simple 50/50 average row-wise (NaN-safe via nanmean).
    final_yoy = np.nanmean(pred_yoy_mat, axis=1)
    final_mom = np.nanmean(pred_mom_mat, axis=1)
    final_mom = np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP)

    weights_used = np.array([0.5, 0.5])

    # Per-base RMSE on aligned panel (diagnostic).
    base_rmse_aligned: dict[str, float] = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        base_rmse_aligned[name] = float(np.sqrt(np.nanmean(diff ** 2)))

    # Pairwise error correlation (theory check on decorrelation hypothesis).
    pair_corr: float | None = None
    try:
        if pred_yoy_mat.shape[1] == 2:
            err_a = pred_yoy_mat[:, 0] - actual_yoy
            err_b = pred_yoy_mat[:, 1] - actual_yoy
            mask = np.isfinite(err_a) & np.isfinite(err_b)
            if mask.sum() >= 4:
                c = np.corrcoef(err_a[mask], err_b[mask])[0, 1]
                if np.isfinite(c):
                    pair_corr = float(c)
    except Exception:
        pair_corr = None

    rows: list[dict] = []
    py_arr, ay_arr, pm_arr, am_arr = [], [], [], []
    for i, m in enumerate(common_months):
        row = {
            "target_month": m,
            "as_of": as_of_per_month[i] if i < len(as_of_per_month) else "",
            "pred_mom": round(float(final_mom[i]), 4),
            "actual_mom": round(float(actual_mom[i]), 4),
            "pred_yoy": round(float(final_yoy[i]), 3),
            "actual_yoy": round(float(actual_yoy[i]), 3),
            "yoy_err": round(float(final_yoy[i]) - float(actual_yoy[i]), 3),
        }
        for j, name in enumerate(base_names):
            try:
                row[f"{name}_pred_yoy"] = round(float(pred_yoy_mat[i, j]), 3)
            except Exception:
                row[f"{name}_pred_yoy"] = None
        rows.append(row)
        py_arr.append(float(final_yoy[i]))
        ay_arr.append(float(actual_yoy[i]))
        pm_arr.append(float(final_mom[i]))
        am_arr.append(float(actual_mom[i]))

    py = np.array(py_arr); ay = np.array(ay_arr)
    pm = np.array(pm_arr); am = np.array(am_arr)
    valid_yoy = np.isfinite(py) & np.isfinite(ay)
    valid_mom = np.isfinite(pm) & np.isfinite(am)
    yoy_err_abs = np.abs(py[valid_yoy] - ay[valid_yoy])

    weights_out = {
        n: round(float(w), 4)
        for n, w in zip(base_names, weights_used)
    }

    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": int(valid_yoy.sum()),
        "rmseMom": float(np.sqrt(np.mean((pm[valid_mom] - am[valid_mom]) ** 2)))
        if valid_mom.any() else float("nan"),
        "rmseYoy": float(np.sqrt(np.mean((py[valid_yoy] - ay[valid_yoy]) ** 2)))
        if valid_yoy.any() else float("nan"),
        "maeYoy": float(np.mean(yoy_err_abs)) if yoy_err_abs.size else float("nan"),
        "hitWithin25bp": float((yoy_err_abs <= 0.25).mean()) * 100
        if yoy_err_abs.size else float("nan"),
        "hitWithin50bp": float((yoy_err_abs <= 0.50).mean()) * 100
        if yoy_err_abs.size else float("nan"),
        "rows": rows,
        "components": base_names,
        "baseErrors": base_errors,
        "baseRmseAligned": base_rmse_aligned,
        "pairwiseErrCorr": pair_corr,
        "chosenApproach": "average_50_50",
        "finalWeights": weights_out,
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_grnyll_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> GrnYllNowcastResult:
    """Live current-month forecast: run both bases, take the 50/50 mean.

    If both bases run: pred_yoy and pred_mom are simple averages. Bands
    use the wider envelope across the two base bands (conservative when
    bases disagree), floored to RESID_FLOOR.

    If only one base survives: pass-through that base's forecast verbatim.
    If both fail: raise RuntimeError with the captured errors.
    """
    base_specs = [
        ("greenspan", _safe_run_greenspan),
        ("yellen",    _safe_run_yellen),
    ]
    base_results: dict[str, object] = {}
    errors: dict[str, str] = {}
    for name, fn in base_specs:
        res, err = fn(as_of_day)
        if res is not None:
            base_results[name] = res
        else:
            errors[name] = err or "unknown"

    if not base_results:
        raise RuntimeError(f"grnyll: both bases failed. errors: {errors}")

    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only = base_results[only_name]
        return GrnYllNowcastResult(
            as_of=getattr(only, "as_of"),
            target_month=getattr(only, "target_month"),
            pred_mom=float(getattr(only, "pred_mom")),
            pred_yoy=float(getattr(only, "pred_yoy")),
            lo80_yoy=float(getattr(only, "lo80_yoy")),
            hi80_yoy=float(getattr(only, "hi80_yoy")),
            days_observed=int(getattr(only, "days_observed", 0)),
            base_preds={only_name: float(getattr(only, "pred_yoy"))},
            weights={only_name: 1.0},
            component_diagnostic={
                "errors": errors,
                "single_base": only_name,
                "chosen_approach": "single_base_passthrough",
            },
        )

    base_names = list(base_results.keys())
    yoy_vec = np.array([float(base_results[n].pred_yoy) for n in base_names])
    mom_vec = np.array([float(base_results[n].pred_mom) for n in base_names])
    lo_vec = np.array([float(base_results[n].lo80_yoy) for n in base_names])
    hi_vec = np.array([float(base_results[n].hi80_yoy) for n in base_names])

    # Simple 50/50 average.
    w = np.array([0.5, 0.5])
    pred_yoy = float(np.dot(yoy_vec, w))
    pred_mom = float(np.clip(np.dot(mom_vec, w), _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Confidence band: take the WIDER envelope (conservative).
    lo80_yoy = float(np.min(lo_vec))
    hi80_yoy = float(np.max(hi_vec))
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    # Use yellen's metadata as the reference (clev_calibrated has the
    # cleanest target-month / as-of pinning).
    ref = base_results.get("yellen") or base_results[base_names[0]]

    component_diag: dict = {"errors": errors, "chosen_approach": "average_50_50"}
    gr = base_results.get("greenspan")
    if gr is not None:
        try:
            component_diag["greenspan_components"] = dict(
                getattr(gr, "component_moms", {})
            )
            component_diag["zillow_source"] = getattr(gr, "zillow_source", None)
            component_diag["used_zillow_scrape"] = getattr(
                gr, "used_zillow_scrape", None,
            )
        except Exception:
            pass
    yl = base_results.get("yellen")
    if yl is not None:
        try:
            component_diag["used_clev_scrape"] = getattr(
                yl, "used_clev_scrape", None,
            )
            component_diag["yellen_bias_shift_mom"] = float(
                getattr(yl, "bias_shift_mom", float("nan"))
            )
            component_diag["yellen_n_calib_rows"] = int(
                getattr(yl, "n_calib_rows", 0)
            )
        except Exception:
            pass

    return GrnYllNowcastResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        base_preds={n: float(base_results[n].pred_yoy) for n in base_names},
        weights={
            n: round(float(wi), 4) for n, wi in zip(base_names, w)
        },
        component_diagnostic=component_diag,
    )
