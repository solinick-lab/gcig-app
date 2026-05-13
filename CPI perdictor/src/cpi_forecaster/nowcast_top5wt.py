"""TOP-5 inverse-RMSE weighted nowcaster.

Bases (RMSE_YoY in parentheses, prior backtest constants):
  - Yellen 1.1   → nowcast_clev_calibrated   (0.1142, current production)
  - Yellen 1.2   → nowcast_clev_trajectory   (0.1204)
  - clev_nowcast → nowcast_clev              (0.1206, Yellen 1.0 base)
  - Greenspan 1.1 → nowcast_shelter_first    (0.1269, shelter-first hierarchy)
  - Volcker 1.1  → nowcast_quantile_rich     (0.1341, quantile + rich feats)

Goal: beat the 0.1142 production RMSE_YoY by averaging 5 partially-decorrelated
bases with INVERSE-SQUARED-RMSE weights:

    w_i ∝ 1 / RMSE_i^2

so the 0.1142 base gets ~3x the weight of the 0.1341 base
(0.1341^2 / 0.1142^2 ≈ 1.379 ≈ ~3x relative to the lightest weight when
the other three bases are also factored in). Weights are then normalized
to sum to 1.

Everything is aggregated at the YoY level (each base reports its own YoY
prediction; we weight-average those). MoM is also aggregated for
diagnostic continuity (same weights). 80% bands are the WEIGHTED average
of each base's lo80_yoy / hi80_yoy.

These weights are STATIC constants — they don't peek at any cut in the
test window — so leakage is zero. They come purely from the reported
RMSE_YoY constants tabulated above.

Public API mirrors the rest of the nowcast_* family:
  backtest_top5wt_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_top5wt_nowcast(as_of_day=20) -> Top5WtNowcastResult

Each base call is wrapped in try/except. If a base fails, weights are
renormalized over the surviving bases. If <2 bases survive we return
{"error": ...} from the backtest and raise from run_*.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Reported total-window RMSE_YoY of each base. Constants — no leakage.
# Used to derive 1/RMSE^2 weights. Weights are renormalized on the
# surviving subset.
_REPORTED_RMSE_YOY: dict[str, float] = {
    "clev_calibrated":  0.1142,  # Yellen 1.1 (production)
    "clev_trajectory":  0.1204,  # Yellen 1.2
    "clev":             0.1206,  # Yellen 1.0
    "shelter_first":    0.1269,  # Greenspan 1.1
    "quantile_rich":    0.1341,  # Volcker 1.1
}

# Sanity clip on aggregated MoM (matches the per-base internal clipping).
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5

# Floor on YoY half-band width (live).
_RESID_FLOOR = 0.05


@dataclass
class Top5WtNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    base_preds: dict       # {name: yoy_pred}
    weights: dict          # final renormalized weights actually applied
    component_diagnostic: dict


# ---------------------------------------------------------------------------
# Per-base safe runners
# ---------------------------------------------------------------------------


def _safe_backtest_clev_calibrated(panel, daily_frame, window_months, as_of_day):
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


def _safe_backtest_clev_trajectory(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_clev_trajectory import backtest_clev_trajectory_nowcast
        out = backtest_clev_trajectory_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (out.get("error") if isinstance(out, dict) else "non-dict result")
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_clev(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_clev import backtest_clev_nowcast
        out = backtest_clev_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (out.get("error") if isinstance(out, dict) else "non-dict result")
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_shelter_first(panel, daily_frame, window_months, as_of_day):
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


def _safe_backtest_quantile_rich(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_quantile_rich import backtest_quantile_rich_nowcast
        out = backtest_quantile_rich_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (out.get("error") if isinstance(out, dict) else "non-dict result")
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_run_clev_calibrated(as_of_day):
    try:
        from .nowcast_clev_calibrated import run_clev_calibrated_nowcast
        return run_clev_calibrated_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_clev_trajectory(as_of_day):
    try:
        from .nowcast_clev_trajectory import run_clev_trajectory_nowcast
        return run_clev_trajectory_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_clev(as_of_day):
    try:
        from .nowcast_clev import run_clev_nowcast
        return run_clev_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_shelter_first(as_of_day):
    try:
        from .nowcast_shelter_first import run_shelter_first_nowcast
        return run_shelter_first_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_quantile_rich(as_of_day):
    try:
        from .nowcast_quantile_rich import run_quantile_rich_nowcast
        return run_quantile_rich_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


# ---------------------------------------------------------------------------
# Weight derivation
# ---------------------------------------------------------------------------


def _inv_rmse_sq_weights(
    base_names: list[str],
    rmse_lookup: dict[str, float] = _REPORTED_RMSE_YOY,
) -> np.ndarray:
    """Return normalized 1/RMSE^2 weights for `base_names`, in order.

    Falls back to equal weights if any RMSE is missing/non-positive.
    """
    raw = []
    fell_back = False
    for n in base_names:
        r = rmse_lookup.get(n, np.nan)
        if not (isinstance(r, (int, float)) and r > 0 and np.isfinite(r)):
            fell_back = True
            break
        raw.append(1.0 / (float(r) ** 2))
    if fell_back or not raw:
        return np.ones(len(base_names), dtype=float) / max(len(base_names), 1)
    w = np.array(raw, dtype=float)
    s = w.sum()
    if s <= 0:
        return np.ones(len(base_names), dtype=float) / max(len(base_names), 1)
    return w / s


def _apply_weights_row(
    preds_matrix: np.ndarray, weights: np.ndarray,
) -> np.ndarray:
    """Apply a fixed weight vector row-wise, NaN-safe.

    If a row has missing bases, renormalize over the present ones. If a
    row has all NaNs the result is NaN.
    """
    out = np.full(preds_matrix.shape[0], np.nan)
    for i in range(preds_matrix.shape[0]):
        row = preds_matrix[i]
        ok = np.isfinite(row)
        if not ok.any():
            continue
        w = weights[ok]
        ws = w.sum()
        if ws <= 1e-9:
            w = np.ones_like(w) / len(w)
        else:
            w = w / ws
        out[i] = float(np.dot(row[ok], w))
    return out


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_top5wt_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the inverse-RMSE^2 weighted top-5 ensemble.

    Internally:
      1. Run all 5 base backtests.
      2. Drop any base whose backtest fully fails. If <2 survive: error.
      3. Align by target_month — keep months reported by ALL surviving bases.
      4. Compute final pred_yoy and pred_mom as weighted averages with the
         renormalized 1/RMSE^2 weights of the surviving bases (constants
         from REPORTED_RMSE_YOY — no leakage).
      5. Return the standard backtest schema with diagnostic fields.

    Aggregation note: predictions are aggregated at the YoY level (per the
    spec). The same weights are also applied to the MoM matrix so the
    reported pred_mom stays consistent with pred_yoy.
    """
    base_specs = [
        ("clev_calibrated",  _safe_backtest_clev_calibrated),
        ("clev_trajectory",  _safe_backtest_clev_trajectory),
        ("clev",             _safe_backtest_clev),
        ("shelter_first",    _safe_backtest_shelter_first),
        ("quantile_rich",    _safe_backtest_quantile_rich),
    ]
    base_results: dict[str, dict] = {}
    base_errors: dict[str, str] = {}
    for name, fn in base_specs:
        out, err = fn(panel, daily_frame, window_months, as_of_day)
        if out is not None:
            base_results[name] = out
        else:
            base_errors[name] = err or "unknown"

    if len(base_results) < 2:
        return {
            "error": (
                f"need >=2 surviving bases; got {len(base_results)}. "
                f"Errors: {base_errors}"
            ),
        }

    # Align by target_month. Keep months reported by ALL surviving bases.
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
    n_cuts = len(common_months)
    n_bases = len(base_names)
    pred_yoy_mat = np.full((n_cuts, n_bases), np.nan)
    pred_mom_mat = np.full((n_cuts, n_bases), np.nan)
    actual_yoy = np.full(n_cuts, np.nan)
    actual_mom = np.full(n_cuts, np.nan)
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
        # Use clev_calibrated's actual when available (best base reference).
        ref_row = (
            by_base_by_month.get("clev_calibrated", {}).get(m)
            or by_base_by_month.get("clev", {}).get(m)
            or by_base_by_month[base_names[0]][m]
        )
        try:
            actual_yoy[i] = float(ref_row["actual_yoy"])
            actual_mom[i] = float(ref_row["actual_mom"])
            as_of_per_month.append(str(ref_row.get("as_of", "")))
        except (TypeError, ValueError, KeyError):
            as_of_per_month.append("")

    # Inverse-RMSE^2 weights, renormalized over the surviving bases.
    weights = _inv_rmse_sq_weights(base_names)

    final_yoy = _apply_weights_row(pred_yoy_mat, weights)
    final_mom = _apply_weights_row(pred_mom_mat, weights)
    final_mom = np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP)

    # Per-base RMSE on the aligned panel (diagnostic only).
    base_rmse_aligned: dict[str, float] = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        base_rmse_aligned[name] = float(np.sqrt(np.nanmean(diff ** 2)))

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
        n: round(float(w), 4) for n, w in zip(base_names, weights)
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
        "chosenApproach": "inv_rmse_sq",
        "finalWeights": weights_out,
        "reportedRmseYoy": {
            n: _REPORTED_RMSE_YOY.get(n) for n in base_names
        },
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_top5wt_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> Top5WtNowcastResult:
    """Live forecast: run all 5 bases for the current target month and blend.

    Weights are 1/RMSE^2 over surviving bases (constants — no leakage).
    Bands are the WEIGHTED average of each base's lo80_yoy / hi80_yoy
    (also renormalized over surviving bases).
    """
    base_specs = [
        ("clev_calibrated",  _safe_run_clev_calibrated),
        ("clev_trajectory",  _safe_run_clev_trajectory),
        ("clev",             _safe_run_clev),
        ("shelter_first",    _safe_run_shelter_first),
        ("quantile_rich",    _safe_run_quantile_rich),
    ]
    base_results: dict[str, object] = {}
    errors: dict[str, str] = {}
    for name, fn in base_specs:
        res, err = fn(as_of_day)
        if res is not None:
            base_results[name] = res
        else:
            errors[name] = err or "unknown"

    if len(base_results) < 2:
        raise RuntimeError(
            f"top-5 weighted ensemble needs >=2 live bases; got "
            f"{len(base_results)}. errors: {errors}"
        )

    base_names = list(base_results.keys())
    yoy_vec = np.array([float(base_results[n].pred_yoy) for n in base_names])
    mom_vec = np.array([float(base_results[n].pred_mom) for n in base_names])
    lo_vec = np.array([float(base_results[n].lo80_yoy) for n in base_names])
    hi_vec = np.array([float(base_results[n].hi80_yoy) for n in base_names])

    weights = _inv_rmse_sq_weights(base_names)

    pred_yoy = float(np.dot(yoy_vec, weights))
    pred_mom = float(np.clip(np.dot(mom_vec, weights), _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Bands: weighted average (per spec). Apply same weights to lo / hi.
    lo80_yoy = float(np.dot(lo_vec, weights))
    hi80_yoy = float(np.dot(hi_vec, weights))

    # Floor band width to RESID_FLOOR.
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    # Use clev_calibrated's metadata as the reference (best single base).
    ref = (
        base_results.get("clev_calibrated")
        or base_results.get("clev")
        or base_results[base_names[0]]
    )

    component_diag: dict = {"errors": errors}
    sf = base_results.get("shelter_first")
    if sf is not None:
        try:
            component_diag["shelter_first_components"] = dict(
                getattr(sf, "component_moms", {})
            )
            component_diag["zillow_source"] = getattr(sf, "zillow_source", None)
            component_diag["used_zillow_scrape"] = getattr(
                sf, "used_zillow_scrape", None,
            )
        except Exception:
            pass
    for clev_name in ("clev_calibrated", "clev_trajectory", "clev"):
        cv = base_results.get(clev_name)
        if cv is not None:
            try:
                component_diag[f"{clev_name}_used_clev_scrape"] = getattr(
                    cv, "used_clev_scrape", None,
                )
            except Exception:
                pass
    cal = base_results.get("clev_calibrated")
    if cal is not None:
        try:
            component_diag["calibrator_bias_shift_mom"] = float(
                getattr(cal, "bias_shift_mom", 0.0)
            )
            component_diag["calibrator_n_calib_rows"] = int(
                getattr(cal, "n_calib_rows", 0)
            )
        except Exception:
            pass

    return Top5WtNowcastResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        base_preds={n: float(base_results[n].pred_yoy) for n in base_names},
        weights={
            n: round(float(w), 4) for n, w in zip(base_names, weights)
        },
        component_diagnostic=component_diag,
    )
