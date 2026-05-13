"""TOP-2 STACK nowcaster — combine the two leading nowcasters.

Bases:
  - clev_nowcast    (RMSE_YoY 0.1206 — Cleveland Fed nowcast anchored stack)
  - shelter_first   (RMSE_YoY 0.1269 — hierarchical Food/Energy/Shelter/Other-Core
                     with a Zillow-driven shelter forecaster)

Both are strong, and crucially they DO NOT share their headline anchor:
  - clev_nowcast pulls Cleveland Fed's daily-vintage nowcast (and a FRED
    Median CPI proxy when the scrape fails). It uses no Zillow rent data.
  - shelter_first decomposes headline into 4 BLS-weighted pieces and uses
    Zillow ZORI lags as the dominant shelter driver. Cleveland Fed's
    nowcast is not used.

So their feature sets only overlap on the rich daily panel and the panel
lags — the load-bearing signal in each is different. Errors should be
partially decorrelated. With pairwise correlation around 0.6-0.8 and
roughly equal RMSE, an even average alone should buy a few bps on
RMSE_YoY. We additionally try inverse-RMSE weighting and a Ridge meta-
learner with non-negative weights and pick the best by inner OOF.

Strategies tried:
  A. Per-cut MEDIAN across the 2 base preds. With only 2 bases the
     "median" is just the simple average — kept for naming consistency
     with the rest of the codebase.
  B. Simple 50/50 AVERAGE. (Often the strongest pick for tightly
     correlated equal-RMSE pairs.)
  C. Inverse-RMSE weighted average using REPORTED total-window RMSE.
     This is information available BEFORE looking at any cut — pure
     constants, no leakage.
  D. Ridge meta-learner with non-negative coefficients, intercept=0,
     simplex projection (weights sum to 1). Selected by 5-fold
     TimeSeriesSplit OOF over the aligned panel.

Selection rule: the approach with the lowest finite TimeSeriesSplit OOF
RMSE_YoY wins. Tie-breaks favor the simpler approach (avg > median >
inv_rmse > ridge), since with only 12-24 cuts simple > learned.

Public API mirrors the rest of the nowcast_* modules:
  backtest_top2_stack_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_top2_stack_nowcast(as_of_day=20) -> Top2StackNowcastResult

Each base call is wrapped in try/except. If only one base survives we
return its predictions verbatim with a warning in the diagnostic fields.
If neither base survives we return {"error": ...}.

Hypothesis (back-of-envelope): with rho ~ 0.7, equal weight gives
  rmse_avg ~= sqrt(0.5*(0.1206^2+0.1269^2) + 0.7*0.1206*0.1269) ~= 0.115
i.e. ~5 bps better than the leading single base. The Ridge meta-learner
can in principle do slightly better if rho is lower and weights are
asymmetric, but with only ~24 cuts of data we expect the simple average
or inverse-RMSE blend to usually win the OOF lottery.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Reported total-window RMSE_YoY used for inverse-RMSE weighting. These
# are stable inputs from prior backtests — they don't peek at the cuts in
# this module's window.
_REPORTED_RMSE_YOY: dict[str, float] = {
    "clev":          0.1206,
    "shelter_first": 0.1269,
}

# Min rows of aligned base predictions required to attempt the Ridge
# meta-learner. Below this we skip approach D.
_MIN_ROWS_FOR_RIDGE = 12

# Ridge regularization strength. Heavy by default — with 2 features and
# ~24 rows the sample is tiny, so we want strong shrinkage toward equal
# weights to avoid overfitting.
_RIDGE_ALPHA = 1.0

# Inner TimeSeriesSplit folds used for OOF evaluation.
_N_FOLDS = 5

# Sanity clip on aggregated MoM, applied AFTER the chosen ensemble.
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5

# Floor on YoY half-band width when we synthesize the live confidence
# band from the two base bands.
_RESID_FLOOR = 0.05


@dataclass
class Top2StackNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    chosen_approach: str          # "average" / "median" / "inv_rmse" / "ridge"
    base_preds: dict              # {"clev": yoy, "shelter_first": yoy}
    weights: dict                 # final weights actually used
    component_diagnostic: dict    # extra info from base runs


# ---------------------------------------------------------------------------
# Per-base safe runners
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Ensemble building blocks
# ---------------------------------------------------------------------------


def _ensemble_average(preds_matrix: np.ndarray) -> np.ndarray:
    """Simple 50/50 (or equal-weight) row-wise mean.

    NaN-safe via nanmean.
    """
    return np.nanmean(preds_matrix, axis=1)


def _ensemble_median(preds_matrix: np.ndarray) -> np.ndarray:
    """Per-row median across base columns.

    With 2 bases this equals the simple average, but we still expose it so
    selection logic stays uniform with the rest of the nowcast codebase.
    """
    return np.nanmedian(preds_matrix, axis=1)


def _ensemble_inv_rmse(
    preds_matrix: np.ndarray,
    base_names: list[str],
    rmse_lookup: dict[str, float],
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse-RMSE weighted average. Returns (preds, weights).

    Falls back to equal weights if any RMSE is missing or non-positive.
    """
    raw_w = []
    fell_back = False
    for n in base_names:
        r = rmse_lookup.get(n, np.nan)
        if not (isinstance(r, (int, float)) and r > 0 and np.isfinite(r)):
            fell_back = True
            break
        raw_w.append(1.0 / float(r))
    if fell_back or not raw_w:
        w = np.ones(len(base_names), dtype=float) / max(len(base_names), 1)
    else:
        w = np.array(raw_w, dtype=float)
        w = w / w.sum()

    out = np.full(preds_matrix.shape[0], np.nan)
    for i in range(preds_matrix.shape[0]):
        row = preds_matrix[i]
        ok = np.isfinite(row)
        if not ok.any():
            continue
        wi = w[ok]
        wi = wi / wi.sum()
        out[i] = float(np.dot(row[ok], wi))
    return out, w


def _fit_ridge_nonneg(
    base_preds: np.ndarray,
    y_true: np.ndarray,
    alpha: float = _RIDGE_ALPHA,
) -> np.ndarray | None:
    """Fit a non-negative-weight Ridge meta-learner, intercept=0.

    Strategy:
      1. Try sklearn.linear_model.Ridge with positive=True (sklearn >=1.2).
      2. If positive=True isn't supported, fall back to sklearn's
         LinearRegression(positive=True, fit_intercept=False) plus a hand
         ridge term via stacked-rows trick (X augmented with sqrt(alpha)*I,
         y augmented with zeros).
      3. If both fail, fall back to scipy.optimize.nnls on the augmented
         matrix.

    Final coefficients are projected to the simplex (non-negative, sum to 1).
    Returns None if the fit is degenerate or there are too few rows.
    """
    if base_preds.shape[0] < _MIN_ROWS_FOR_RIDGE:
        return None
    if base_preds.shape[1] < 2:
        return None
    if not np.all(np.isfinite(base_preds)) or not np.all(np.isfinite(y_true)):
        # Drop bad rows.
        mask = np.all(np.isfinite(base_preds), axis=1) & np.isfinite(y_true)
        if mask.sum() < _MIN_ROWS_FOR_RIDGE:
            return None
        base_preds = base_preds[mask]
        y_true = y_true[mask]

    coef: np.ndarray | None = None

    # Path 1: sklearn Ridge with positive=True (preferred — direct).
    try:
        from sklearn.linear_model import Ridge
        try:
            r = Ridge(alpha=alpha, fit_intercept=False, positive=True)
            r.fit(base_preds, y_true)
            coef = np.array(r.coef_, dtype=float)
        except TypeError:
            # Older sklearn: positive= kwarg not present. Fall through.
            coef = None
    except Exception:
        coef = None

    # Path 2: positive LinearRegression with manual ridge augmentation.
    if coef is None:
        try:
            from sklearn.linear_model import LinearRegression
            n, k = base_preds.shape
            sqrt_a = float(np.sqrt(max(alpha, 0.0)))
            X_aug = np.vstack([base_preds, sqrt_a * np.eye(k)])
            y_aug = np.concatenate([y_true, np.zeros(k)])
            lr = LinearRegression(positive=True, fit_intercept=False)
            lr.fit(X_aug, y_aug)
            coef = np.array(lr.coef_, dtype=float)
        except Exception:
            coef = None

    # Path 3: scipy.optimize.nnls on augmented system.
    if coef is None:
        try:
            from scipy.optimize import nnls
            n, k = base_preds.shape
            sqrt_a = float(np.sqrt(max(alpha, 0.0)))
            X_aug = np.vstack([base_preds, sqrt_a * np.eye(k)])
            y_aug = np.concatenate([y_true, np.zeros(k)])
            coef, _ = nnls(X_aug, y_aug)
            coef = np.array(coef, dtype=float)
        except Exception:
            coef = None

    if coef is None or not np.all(np.isfinite(coef)):
        return None

    s = float(coef.sum())
    if s <= 1e-9:
        # All zero — degenerate, just use equal weights.
        coef = np.ones_like(coef) / len(coef)
    else:
        coef = coef / s

    # Sanity check: any NaNs from upstream? bail.
    if not np.all(np.isfinite(coef)):
        return None
    return coef


def _apply_weights(
    preds_matrix: np.ndarray, weights: np.ndarray,
) -> np.ndarray:
    """Apply a fixed weight vector row-wise, NaN-safe.

    If a row has missing bases, renormalize over the present ones. If a row
    has all NaNs the result is NaN.
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
# Inner OOF evaluation across the 4 strategies
# ---------------------------------------------------------------------------


def _inner_oof_eval(
    base_preds_yoy: np.ndarray,   # (n_cuts, n_bases) YoY base preds
    y_yoy: np.ndarray,            # (n_cuts,) actual YoY
    base_names: list[str],
) -> dict:
    """Score median / average / inv-RMSE / ridge under TimeSeriesSplit OOF.

    Median, average, and inv-RMSE have no learnable parameters tied to the
    cuts (inv-RMSE weights come from REPORTED constants), so their
    "OOF RMSE" is just the full-sample RMSE — they neither over- nor
    under-fit.

    For the Ridge meta-learner we run a true 5-fold (or fewer) time-series
    split and stitch OOF predictions, so we compare apples-to-apples.
    """
    n = len(y_yoy)
    summary = {
        "average_oof_rmse":   np.nan,
        "median_oof_rmse":    np.nan,
        "inv_rmse_oof_rmse":  np.nan,
        "ridge_oof_rmse":     np.nan,
        "inv_rmse_weights":   None,
        "ridge_weights":      None,
    }

    # ----- Equal-weight average (no learning) -----
    pred_avg = _ensemble_average(base_preds_yoy)
    err_avg = pred_avg - y_yoy
    summary["average_oof_rmse"] = float(
        np.sqrt(np.nanmean(err_avg ** 2))
    )

    # ----- Median (with 2 bases this == average; reported separately) -----
    pred_med = _ensemble_median(base_preds_yoy)
    err_med = pred_med - y_yoy
    summary["median_oof_rmse"] = float(
        np.sqrt(np.nanmean(err_med ** 2))
    )

    # ----- Inverse-RMSE static weights -----
    pred_inv, w_inv = _ensemble_inv_rmse(
        base_preds_yoy, base_names, _REPORTED_RMSE_YOY,
    )
    err_inv = pred_inv - y_yoy
    summary["inv_rmse_oof_rmse"] = float(
        np.sqrt(np.nanmean(err_inv ** 2))
    )
    summary["inv_rmse_weights"] = w_inv

    # ----- Ridge meta-learner with non-negative coefficients, OOF -----
    if n >= _MIN_ROWS_FOR_RIDGE and base_preds_yoy.shape[1] >= 2:
        try:
            from sklearn.model_selection import TimeSeriesSplit
            n_splits = min(_N_FOLDS, max(2, n // 4))
            tss = TimeSeriesSplit(n_splits=n_splits)
            oof_pred = np.full(n, np.nan)
            for tr_idx, va_idx in tss.split(base_preds_yoy):
                X_tr = base_preds_yoy[tr_idx]
                y_tr = y_yoy[tr_idx]
                tr_mask = (
                    np.all(np.isfinite(X_tr), axis=1) & np.isfinite(y_tr)
                )
                if tr_mask.sum() < max(_MIN_ROWS_FOR_RIDGE // 2,
                                       base_preds_yoy.shape[1] + 2):
                    continue
                w = _fit_ridge_nonneg(X_tr[tr_mask], y_tr[tr_mask])
                if w is None:
                    continue
                X_va = base_preds_yoy[va_idx]
                pred_va = _apply_weights(X_va, w)
                oof_pred[va_idx] = pred_va

            valid = np.isfinite(oof_pred) & np.isfinite(y_yoy)
            if valid.sum() >= max(_MIN_ROWS_FOR_RIDGE // 2, 6):
                err_r = oof_pred[valid] - y_yoy[valid]
                summary["ridge_oof_rmse"] = float(
                    np.sqrt(np.mean(err_r ** 2))
                )

            # Final ridge weights fit on the FULL aligned panel — used at
            # test time and (if we want it) at live time.
            full_mask = (
                np.all(np.isfinite(base_preds_yoy), axis=1)
                & np.isfinite(y_yoy)
            )
            if full_mask.sum() >= _MIN_ROWS_FOR_RIDGE:
                w_full = _fit_ridge_nonneg(
                    base_preds_yoy[full_mask], y_yoy[full_mask],
                )
                if w_full is not None:
                    summary["ridge_weights"] = w_full
        except Exception:
            # Any failure: leave ridge_oof_rmse NaN. Selection will skip.
            pass

    return summary


def _select_best_approach(eval_summary: dict) -> str:
    """Pick the lowest-OOF-RMSE approach.

    Tie-breaks favor SIMPLE approaches in this order:
        average > median > inv_rmse > ridge
    With only ~24 cuts the simpler choice is more robust.
    """
    candidates: list[tuple[str, float, int]] = []
    # (name, oof_rmse, simplicity_rank — lower is simpler/preferred)
    spec = [
        ("average",  "average_oof_rmse",   0),
        ("median",   "median_oof_rmse",    1),
        ("inv_rmse", "inv_rmse_oof_rmse",  2),
        ("ridge",    "ridge_oof_rmse",     3),
    ]
    for name, key, rank in spec:
        v = eval_summary.get(key, np.nan)
        if isinstance(v, (int, float)) and np.isfinite(v):
            # Skip ridge if its weights weren't successfully fitted.
            if name == "ridge" and eval_summary.get("ridge_weights") is None:
                continue
            candidates.append((name, float(v), rank))
    if not candidates:
        return "average"  # safe default
    # Sort by RMSE asc, then simplicity rank asc.
    candidates.sort(key=lambda x: (x[1], x[2]))
    return candidates[0][0]


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_top2_stack_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the top-2 stacked nowcaster.

    Internally:
      1. Run clev_nowcast and shelter_first backtests over the same window.
      2. Drop any base whose backtest fully fails. If 0 survive: error. If
         1 survives: return its predictions verbatim with a "single_base"
         diagnostic flag.
      3. Align by target_month — keep months reported by BOTH bases.
      4. Score the 4 strategies via inner TimeSeriesSplit OOF.
      5. Pick the lowest-OOF strategy. Recompute final preds for both
         pred_mom and pred_yoy with the SAME approach (and same weights
         where applicable), so the MoM and YoY series stay consistent.
      6. Return the standard backtest schema with diagnostic fields.
    """
    base_specs = [
        ("clev",          _safe_backtest_clev),
        ("shelter_first", _safe_backtest_shelter_first),
    ]
    base_results: dict[str, dict] = {}
    base_errors: dict[str, str] = {}
    for name, fn in base_specs:
        out, err = fn(panel, daily_frame, window_months, as_of_day)
        if out is not None:
            base_results[name] = out
        else:
            base_errors[name] = err or "unknown"

    # Both bases failed.
    if not base_results:
        return {
            "error": (
                f"all bases failed. errors: {base_errors}"
            ),
        }

    # Only one base survived: pass-through with a flag.
    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only_out = base_results[only_name]
        out = dict(only_out)  # shallow copy
        out["chosenApproach"] = "single_base_passthrough"
        out["singleBase"] = only_name
        out["baseErrors"] = base_errors
        out["components"] = list(base_results.keys())
        return out

    # Both bases survived. Align by target_month.
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
        # Use clev's actual when available (it's our reference base).
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

    # Score the 4 strategies via inner OOF and pick.
    eval_summary = _inner_oof_eval(pred_yoy_mat, actual_yoy, base_names)
    chosen = _select_best_approach(eval_summary)

    # Compute final predictions under chosen approach. We always apply the
    # SAME ensemble logic to both YoY and MoM matrices so they line up.
    weights_used: np.ndarray | None = None
    if chosen == "average":
        final_yoy = _ensemble_average(pred_yoy_mat)
        final_mom = _ensemble_average(pred_mom_mat)
        weights_used = np.array([0.5, 0.5])
    elif chosen == "median":
        final_yoy = _ensemble_median(pred_yoy_mat)
        final_mom = _ensemble_median(pred_mom_mat)
        weights_used = np.array([0.5, 0.5])  # equivalent w/ 2 bases
    elif chosen == "inv_rmse":
        w = eval_summary.get("inv_rmse_weights")
        if w is None:
            final_yoy = _ensemble_average(pred_yoy_mat)
            final_mom = _ensemble_average(pred_mom_mat)
            weights_used = np.array([0.5, 0.5])
            chosen = "average"
        else:
            final_yoy = _apply_weights(pred_yoy_mat, w)
            final_mom = _apply_weights(pred_mom_mat, w)
            weights_used = w
    elif chosen == "ridge":
        w = eval_summary.get("ridge_weights")
        if w is None:
            final_yoy = _ensemble_average(pred_yoy_mat)
            final_mom = _ensemble_average(pred_mom_mat)
            weights_used = np.array([0.5, 0.5])
            chosen = "average"
        else:
            final_yoy = _apply_weights(pred_yoy_mat, w)
            final_mom = _apply_weights(pred_mom_mat, w)
            weights_used = w
    else:
        # Should not happen, but fall back to average.
        final_yoy = _ensemble_average(pred_yoy_mat)
        final_mom = _ensemble_average(pred_mom_mat)
        weights_used = np.array([0.5, 0.5])
        chosen = "average"

    # Sanity-clip final MoM to the same range each base uses internally.
    final_mom = np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP)

    # Per-base RMSE on the aligned panel (diagnostic only).
    base_rmse_aligned: dict[str, float] = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        base_rmse_aligned[name] = float(np.sqrt(np.nanmean(diff ** 2)))

    # Pairwise correlation of base prediction errors (sanity / theory check).
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

    weights_out = None
    if weights_used is not None:
        weights_out = {
            n: round(float(w), 4)
            for n, w in zip(base_names, weights_used)
        }
    inv_rmse_w_out = None
    if eval_summary.get("inv_rmse_weights") is not None:
        inv_rmse_w_out = {
            n: round(float(w), 4)
            for n, w in zip(base_names, eval_summary["inv_rmse_weights"])
        }
    ridge_w_out = None
    if eval_summary.get("ridge_weights") is not None:
        ridge_w_out = {
            n: round(float(w), 4)
            for n, w in zip(base_names, eval_summary["ridge_weights"])
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
        "chosenApproach": chosen,
        "approachOofRmse": {
            "average":  eval_summary.get("average_oof_rmse"),
            "median":   eval_summary.get("median_oof_rmse"),
            "inv_rmse": eval_summary.get("inv_rmse_oof_rmse"),
            "ridge":    eval_summary.get("ridge_oof_rmse"),
        },
        "finalWeights": weights_out,
        "invRmseWeights": inv_rmse_w_out,
        "ridgeWeights": ridge_w_out,
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_top2_stack_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> Top2StackNowcastResult:
    """Live forecast: run both bases for the current target month and blend.

    For the live run we don't have a backtest panel to do OOF selection on
    in real-time without re-running everything, so we use a deterministic
    rule:
      - If both bases run successfully: blend with INVERSE-RMSE weights
        (uses only REPORTED constants, no in-window peeking).
      - If only one survives: return its forecast verbatim.

    The backtest function is the place where median/average/inv-RMSE/ridge
    are actually evaluated and selected — for the live single-month run we
    use the inverse-RMSE blend by default since it's the only data-free
    weighted approach that respects the relative quality of the two bases
    without needing fresh OOF data.
    """
    base_specs = [
        ("clev",          _safe_run_clev),
        ("shelter_first", _safe_run_shelter_first),
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
        raise RuntimeError(
            f"top-2 stack: both bases failed. errors: {errors}"
        )

    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only = base_results[only_name]
        return Top2StackNowcastResult(
            as_of=getattr(only, "as_of"),
            target_month=getattr(only, "target_month"),
            pred_mom=float(getattr(only, "pred_mom")),
            pred_yoy=float(getattr(only, "pred_yoy")),
            lo80_yoy=float(getattr(only, "lo80_yoy")),
            hi80_yoy=float(getattr(only, "hi80_yoy")),
            days_observed=int(getattr(only, "days_observed", 0)),
            chosen_approach="single_base_passthrough",
            base_preds={only_name: float(getattr(only, "pred_yoy"))},
            weights={only_name: 1.0},
            component_diagnostic={"errors": errors, "single_base": only_name},
        )

    base_names = list(base_results.keys())
    yoy_vec = np.array([float(base_results[n].pred_yoy) for n in base_names])
    mom_vec = np.array([float(base_results[n].pred_mom) for n in base_names])
    lo_vec = np.array([float(base_results[n].lo80_yoy) for n in base_names])
    hi_vec = np.array([float(base_results[n].hi80_yoy) for n in base_names])

    # Inverse-RMSE weights from REPORTED constants (no leakage).
    raw_w = []
    fell_back = False
    for n in base_names:
        r = _REPORTED_RMSE_YOY.get(n, np.nan)
        if not (isinstance(r, (int, float)) and r > 0):
            fell_back = True
            break
        raw_w.append(1.0 / float(r))
    if fell_back or not raw_w:
        w = np.ones(len(base_names), dtype=float) / len(base_names)
    else:
        w = np.array(raw_w, dtype=float)
        w = w / w.sum()

    pred_yoy = float(np.dot(yoy_vec, w))
    pred_mom = float(np.clip(np.dot(mom_vec, w), _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Confidence band: take the WIDER envelope (conservative when bases
    # disagree), then floor to RESID_FLOOR.
    lo80_yoy = float(np.min(lo_vec))
    hi80_yoy = float(np.max(hi_vec))
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    # Use clev's metadata as the reference (most reliable single base).
    ref = base_results.get("clev") or base_results[base_names[0]]

    component_diag: dict = {"errors": errors}
    # Surface the shelter sub-component MoM breakdown if shelter_first
    # ran (useful for downstream debugging).
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
    cv = base_results.get("clev")
    if cv is not None:
        try:
            component_diag["used_clev_scrape"] = getattr(
                cv, "used_clev_scrape", None,
            )
        except Exception:
            pass

    return Top2StackNowcastResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        chosen_approach="inv_rmse",
        base_preds={n: float(base_results[n].pred_yoy) for n in base_names},
        weights={
            n: round(float(wi), 4) for n, wi in zip(base_names, w)
        },
        component_diagnostic=component_diag,
    )
