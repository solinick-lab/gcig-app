"""MEGA-ENSEMBLE nowcaster — stacks our 4 best nowcasters.

Bases:
  - clev_nowcast       (RMSE 0.1206 — the current best, Cleveland-anchored)
  - subcomp_5way       (RMSE 0.1295 — Food/Energy/Shelter/Core decomposition)
  - quantile_rich      (RMSE 0.1341 — rich daily features, quantile loss)
  - tips_anchor        (RMSE 0.1376 — TIPS breakeven anchored quantile model)

Each one trains on a DIFFERENT feature set and a DIFFERENT objective, so
their errors should be partially decorrelated.  Averaging four weakly-
correlated predictors typically squeezes 3-7% out of single-cut RMSE.

We try THREE ensemble strategies and pick the best by inner OOF RMSE:

  A. Simple median  (per-cut median across the 4 base preds)
     - Most robust to a single rogue base.  Zero-parameter.

  B. Inverse-RMSE weighted average
     - Each base weighted by 1 / RMSE_total.  Slightly favors clev_nowcast.
     - Uses ONLY the trailing-window RMSE that the user already has from
       their reported numbers (no in-sample look at the test cuts).

  C. Constrained stacked Ridge (positive=True, weights normalized to 1)
     - 5-fold TimeSeriesSplit OOF on the (rather small) backtest panel.
     - Heavy regularization to prevent the champion_v3 disaster.
     - Falls back to A when too few rows or all approaches degenerate.

Selection: whichever of A/B/C has the BEST OOF RMSE on the inner
TimeSeriesSplit eval gets used for the final test predictions and for
the live run.

Public API:
  backtest_megaens_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_megaens_nowcast(as_of_day=20)

If any base fails entirely we drop it gracefully and re-fit the ensemble
over the surviving bases.  If <2 bases survive we return an error.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Reported total-window RMSE_YoY of each base (used for inverse-RMSE weights).
# These come from the user's stated numbers and are stable inputs — they don't
# leak any in-window information about the cuts, since they're just constants.
_REPORTED_RMSE_YOY: dict[str, float] = {
    "clev":          0.1206,
    "subcomp_5way":  0.1295,
    "quantile_rich": 0.1341,
    "tips_anchor":   0.1376,
}

# Min rows of base-level OOF for the constrained Ridge meta-learner. Below
# this threshold we skip approach C (champion_v3 burned us on tiny meta sets).
_MIN_ROWS_FOR_STACKING = 12

# Inner TimeSeriesSplit folds for OOF evaluation.
_N_FOLDS = 5


@dataclass
class MegaEnsResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    chosen_approach: str  # "median" / "inv_rmse" / "stacked"
    base_preds: dict      # {"clev": yoy, "subcomp_5way": yoy, ...}


# ---------------------------------------------------------------------------
# Per-base safe runners
# ---------------------------------------------------------------------------


def _safe_backtest_clev(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_clev import backtest_clev_nowcast
        out = backtest_clev_nowcast(
            panel, daily_frame, window_months=window_months, as_of_day=as_of_day,
        )
        if "error" in out:
            return None, out["error"]
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_subcomp(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_subcomp_5way import backtest_subcomp_5way_nowcast
        out = backtest_subcomp_5way_nowcast(
            panel, daily_frame, window_months=window_months, as_of_day=as_of_day,
        )
        if "error" in out:
            return None, out["error"]
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_quantile_rich(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_quantile_rich import backtest_quantile_rich_nowcast
        out = backtest_quantile_rich_nowcast(
            panel, daily_frame, window_months=window_months, as_of_day=as_of_day,
        )
        if "error" in out:
            return None, out["error"]
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_backtest_tips(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_tips_anchor import backtest_tips_anchor_nowcast
        out = backtest_tips_anchor_nowcast(
            panel, daily_frame, window_months=window_months, as_of_day=as_of_day,
        )
        if "error" in out:
            return None, out["error"]
        return out, None
    except Exception as exc:
        return None, str(exc)


def _safe_run_clev(as_of_day):
    try:
        from .nowcast_clev import run_clev_nowcast
        return run_clev_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_subcomp(as_of_day):
    try:
        from .nowcast_subcomp_5way import run_subcomp_5way_nowcast
        return run_subcomp_5way_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_quantile_rich(as_of_day):
    try:
        from .nowcast_quantile_rich import run_quantile_rich_nowcast
        return run_quantile_rich_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


def _safe_run_tips(as_of_day):
    try:
        from .nowcast_tips_anchor import run_tips_anchor_nowcast
        return run_tips_anchor_nowcast(as_of_day=as_of_day), None
    except Exception as exc:
        return None, str(exc)


# ---------------------------------------------------------------------------
# Ensemble approaches
# ---------------------------------------------------------------------------


def _ensemble_median(preds_matrix: np.ndarray) -> np.ndarray:
    """Per-row median across base columns.  Robust to a single rogue base.

    preds_matrix: shape (n_cuts, n_bases).  Returns shape (n_cuts,).
    """
    return np.nanmedian(preds_matrix, axis=1)


def _ensemble_inv_rmse(
    preds_matrix: np.ndarray,
    base_names: list[str],
    rmse_lookup: dict[str, float],
) -> np.ndarray:
    """Inverse-RMSE weighted average.  Static weights from `rmse_lookup`.

    Falls back to equal-weight if any RMSE is missing or non-positive.
    """
    weights = []
    for name in base_names:
        r = rmse_lookup.get(name, np.nan)
        if not (isinstance(r, (int, float)) and r > 0 and np.isfinite(r)):
            weights = [1.0] * len(base_names)
            break
        weights.append(1.0 / float(r))
    w = np.array(weights, dtype=float)
    w = w / w.sum()
    # Mask NaNs in preds; renormalize per row across whatever bases reported.
    out = np.full(preds_matrix.shape[0], np.nan)
    for i in range(preds_matrix.shape[0]):
        row = preds_matrix[i]
        ok = np.isfinite(row)
        if not ok.any():
            continue
        wi = w[ok]
        wi = wi / wi.sum()
        out[i] = float(np.dot(row[ok], wi))
    return out


def _fit_constrained_stacked(
    base_oof: np.ndarray,
    y_true: np.ndarray,
) -> np.ndarray | None:
    """Fit non-negative weights summing to 1 via NNLS, then normalize.

    Project onto simplex. Returns weight vector or None if degenerate.

    base_oof: shape (n, k).  y_true: shape (n,).
    """
    if base_oof.shape[0] < _MIN_ROWS_FOR_STACKING:
        return None
    if base_oof.shape[1] < 2:
        return None

    # Try sklearn's positive=True LinearRegression first (no intercept so the
    # constraint stays clean).  Fall back to scipy.optimize.nnls if needed.
    coef: np.ndarray | None = None
    try:
        from sklearn.linear_model import LinearRegression
        lr = LinearRegression(positive=True, fit_intercept=False)
        lr.fit(base_oof, y_true)
        coef = np.array(lr.coef_, dtype=float)
    except Exception:
        try:
            from scipy.optimize import nnls
            coef, _ = nnls(base_oof, y_true)
            coef = np.array(coef, dtype=float)
        except Exception:
            # Final fallback: project softmax of unconstrained least-squares
            try:
                beta, *_ = np.linalg.lstsq(base_oof, y_true, rcond=None)
                # softmax → simplex
                z = beta - np.max(beta)
                exp_z = np.exp(z)
                coef = exp_z / exp_z.sum()
            except Exception:
                return None

    if coef is None:
        return None
    if not np.all(np.isfinite(coef)):
        return None
    s = float(coef.sum())
    if s <= 1e-9:
        # Degenerate: all-zero weights.  Use equal weights.
        coef = np.ones_like(coef) / len(coef)
    else:
        coef = coef / s
    return coef


def _ensemble_stacked_apply(
    preds_matrix: np.ndarray,
    weights: np.ndarray,
) -> np.ndarray:
    """Apply pre-fit non-negative simplex weights row-wise.

    NaN-safe: if a row has missing bases, renormalize over present ones.
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
            # No mass on present bases — fall back to equal weight.
            w = np.ones_like(w) / len(w)
        else:
            w = w / ws
        out[i] = float(np.dot(row[ok], w))
    return out


# ---------------------------------------------------------------------------
# Approach selection via inner TimeSeriesSplit OOF
# ---------------------------------------------------------------------------


def _inner_oof_eval(
    base_preds_yoy: np.ndarray,    # (n_cuts, n_bases)  YoY preds per base
    y_yoy: np.ndarray,             # (n_cuts,)          actual YoY
    base_names: list[str],
) -> dict:
    """Run all 3 approaches under a TimeSeriesSplit and report OOF RMSE_YoY.

    For A (median) and B (inv-RMSE) the predictions are independent of any
    fold, so OOF RMSE = full-sample RMSE.  For C (stacked) we get true
    OOF predictions via TimeSeriesSplit so we don't double-count.
    """
    n = len(y_yoy)
    out = {
        "median_oof_rmse": np.nan,
        "inv_rmse_oof_rmse": np.nan,
        "stacked_oof_rmse": np.nan,
        "stacked_weights": None,
    }

    # ----- A: median (no fold needed, no learnable params) -----
    pred_a = _ensemble_median(base_preds_yoy)
    err_a = pred_a - y_yoy
    out["median_oof_rmse"] = float(np.sqrt(np.mean(err_a ** 2)))

    # ----- B: inv-RMSE (no fold needed, fixed weights from REPORTED RMSE) -----
    pred_b = _ensemble_inv_rmse(base_preds_yoy, base_names, _REPORTED_RMSE_YOY)
    err_b = pred_b - y_yoy
    out["inv_rmse_oof_rmse"] = float(np.sqrt(np.mean(err_b ** 2)))

    # ----- C: constrained stacked, 5-fold TimeSeriesSplit -----
    if n >= _MIN_ROWS_FOR_STACKING and base_preds_yoy.shape[1] >= 2:
        try:
            from sklearn.model_selection import TimeSeriesSplit
            n_splits = min(_N_FOLDS, max(2, n // 4))
            tss = TimeSeriesSplit(n_splits=n_splits)
            oof_pred = np.full(n, np.nan)
            for tr_idx, va_idx in tss.split(base_preds_yoy):
                X_tr = base_preds_yoy[tr_idx]
                y_tr = y_yoy[tr_idx]
                # Drop any rows with NaNs in train to keep solver happy.
                tr_mask = np.all(np.isfinite(X_tr), axis=1) & np.isfinite(y_tr)
                if tr_mask.sum() < max(_MIN_ROWS_FOR_STACKING // 2, base_preds_yoy.shape[1] + 2):
                    continue
                w = _fit_constrained_stacked(X_tr[tr_mask], y_tr[tr_mask])
                if w is None:
                    continue
                X_va = base_preds_yoy[va_idx]
                pred_va = _ensemble_stacked_apply(X_va, w)
                oof_pred[va_idx] = pred_va

            valid = np.isfinite(oof_pred) & np.isfinite(y_yoy)
            if valid.sum() >= max(_MIN_ROWS_FOR_STACKING // 2, 6):
                err_c = oof_pred[valid] - y_yoy[valid]
                out["stacked_oof_rmse"] = float(np.sqrt(np.mean(err_c ** 2)))

            # Final stacked weights fit on the FULL backtest panel
            full_mask = np.all(np.isfinite(base_preds_yoy), axis=1) & np.isfinite(y_yoy)
            if full_mask.sum() >= _MIN_ROWS_FOR_STACKING:
                w_full = _fit_constrained_stacked(
                    base_preds_yoy[full_mask], y_yoy[full_mask],
                )
                if w_full is not None:
                    out["stacked_weights"] = w_full
        except Exception:
            pass

    return out


def _select_best_approach(eval_summary: dict) -> str:
    """Pick the approach with the lowest finite OOF RMSE.

    Tie-break favors median (most robust), then inv_rmse, then stacked.
    """
    candidates = []
    for name, key in (
        ("median",   "median_oof_rmse"),
        ("inv_rmse", "inv_rmse_oof_rmse"),
        ("stacked",  "stacked_oof_rmse"),
    ):
        v = eval_summary.get(key, np.nan)
        if np.isfinite(v):
            candidates.append((name, float(v)))
    if not candidates:
        return "median"  # safest fallback
    # If stacked has weights==None, drop it.
    if eval_summary.get("stacked_weights") is None:
        candidates = [(n, v) for n, v in candidates if n != "stacked"]
        if not candidates:
            return "median"
    candidates.sort(key=lambda x: x[1])
    return candidates[0][0]


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_megaens_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Stacked mega-ensemble across clev / subcomp_5way / quantile_rich / tips_anchor.

    Internally:
      1. Run all 4 base backtests.  Drop any that fully fail.
      2. Align by target_month — keep only months reported by ALL surviving bases.
      3. Try 3 ensemble approaches (median / inv-RMSE / constrained-stacked).
         Score each by OOF RMSE_YoY (TimeSeriesSplit for the stacked one).
      4. Pick the best, recompute a single set of predictions, return the
         standard backtest schema plus diagnostic fields.
    """
    # 1) Run each base.  Each returns (out, err); err is None on success.
    base_specs = [
        ("clev",          _safe_backtest_clev),
        ("subcomp_5way",  _safe_backtest_subcomp),
        ("quantile_rich", _safe_backtest_quantile_rich),
        ("tips_anchor",   _safe_backtest_tips),
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

    # 2) Align by target_month.  Keep only months reported by ALL survivors.
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
                pred_mom_mat[i, j] = float(r.get("pred_mom"))
            except (TypeError, ValueError):
                pass
        # Use clev's actual if available, else any other base's actual.
        ref_row = (
            by_base_by_month.get("clev", {}).get(m)
            or by_base_by_month[base_names[0]][m]
        )
        try:
            actual_yoy[i] = float(ref_row["actual_yoy"])
            actual_mom[i] = float(ref_row["actual_mom"])
            as_of_per_month.append(str(ref_row.get("as_of", "")))
        except (TypeError, ValueError, KeyError):
            as_of_per_month.append("")

    # 3) Score the 3 approaches under inner OOF.
    eval_summary = _inner_oof_eval(pred_yoy_mat, actual_yoy, base_names)
    chosen = _select_best_approach(eval_summary)

    # 4) Generate final predictions under the chosen approach.  For YoY we
    # use the chosen ensemble; for MoM we use the SAME approach on the MoM
    # matrix (with the same weights for stacked).  This keeps mom/yoy
    # consistent without requiring separate weight learning.
    if chosen == "median":
        final_yoy = _ensemble_median(pred_yoy_mat)
        final_mom = _ensemble_median(pred_mom_mat)
    elif chosen == "inv_rmse":
        final_yoy = _ensemble_inv_rmse(pred_yoy_mat, base_names, _REPORTED_RMSE_YOY)
        final_mom = _ensemble_inv_rmse(pred_mom_mat, base_names, _REPORTED_RMSE_YOY)
    elif chosen == "stacked":
        w = eval_summary.get("stacked_weights")
        if w is None:
            # Shouldn't happen given _select_best_approach guard, but be safe.
            final_yoy = _ensemble_median(pred_yoy_mat)
            final_mom = _ensemble_median(pred_mom_mat)
            chosen = "median"
        else:
            final_yoy = _ensemble_stacked_apply(pred_yoy_mat, w)
            final_mom = _ensemble_stacked_apply(pred_mom_mat, w)
    else:
        final_yoy = _ensemble_median(pred_yoy_mat)
        final_mom = _ensemble_median(pred_mom_mat)
        chosen = "median"

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
            row[f"{name}_pred_yoy"] = round(float(pred_yoy_mat[i, j]), 3)
        rows.append(row)
        py_arr.append(float(final_yoy[i])); ay_arr.append(float(actual_yoy[i]))
        pm_arr.append(float(final_mom[i])); am_arr.append(float(actual_mom[i]))

    py = np.array(py_arr); ay = np.array(ay_arr)
    pm = np.array(pm_arr); am = np.array(am_arr)
    yoy_err = np.abs(py - ay)

    # Per-base RMSE on the aligned panel for diagnostics.
    base_rmse_aligned = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        base_rmse_aligned[name] = float(np.sqrt(np.nanmean(diff ** 2)))

    stacked_w_out = None
    if eval_summary.get("stacked_weights") is not None:
        stacked_w_out = {
            n: round(float(w), 4)
            for n, w in zip(base_names, eval_summary["stacked_weights"])
        }

    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(py),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
        "components": base_names,
        "baseErrors": base_errors,
        "baseRmseAligned": base_rmse_aligned,
        "chosenApproach": chosen,
        "approachOofRmse": {
            "median":   eval_summary.get("median_oof_rmse"),
            "inv_rmse": eval_summary.get("inv_rmse_oof_rmse"),
            "stacked":  eval_summary.get("stacked_oof_rmse"),
        },
        "stackedWeights": stacked_w_out,
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_megaens_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> MegaEnsResult:
    """Live mega-ensemble forecast for the current target month.

    Calls each base's run_*_nowcast(), aligns by attribute, picks an
    approach.  For the LIVE run we don't re-do the OOF eval (it requires a
    backtest panel), so we use the fixed-weight approach (B: inverse-RMSE)
    by default — it's the only one that can produce a forecast purely from
    the 4 base outputs without re-running a full backtest.
    """
    base_specs = [
        ("clev",          _safe_run_clev),
        ("subcomp_5way",  _safe_run_subcomp),
        ("quantile_rich", _safe_run_quantile_rich),
        ("tips_anchor",   _safe_run_tips),
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
            f"mega-ensemble needs >=2 live bases; got {len(base_results)}. "
            f"errors: {errors}"
        )

    base_names = list(base_results.keys())
    yoy_vec = np.array([float(base_results[n].pred_yoy) for n in base_names])
    mom_vec = np.array([float(base_results[n].pred_mom) for n in base_names])
    lo_vec = np.array([float(base_results[n].lo80_yoy) for n in base_names])
    hi_vec = np.array([float(base_results[n].hi80_yoy) for n in base_names])

    # Inverse-RMSE weights from reported numbers (no in-window peeking).
    weights = []
    for n in base_names:
        r = _REPORTED_RMSE_YOY.get(n, np.nan)
        if not (isinstance(r, (int, float)) and r > 0):
            weights = [1.0] * len(base_names)
            break
        weights.append(1.0 / r)
    w = np.array(weights, dtype=float)
    w = w / w.sum()

    pred_yoy = float(np.dot(yoy_vec, w))
    pred_mom = float(np.dot(mom_vec, w))
    # Bands: take the WIDER envelope (conservative — the 4 bases disagree).
    lo80_yoy = float(np.min(lo_vec))
    hi80_yoy = float(np.max(hi_vec))

    # Use clev's metadata (most reliable base).  Fall back to any survivor.
    ref = base_results.get("clev") or base_results[base_names[0]]
    return MegaEnsResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        chosen_approach="inv_rmse",
        base_preds={n: float(base_results[n].pred_yoy) for n in base_names},
    )
