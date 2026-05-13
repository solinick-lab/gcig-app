"""BAYESIAN MODEL AVERAGING (BMA) nowcaster — posterior-weighted average of 5 bases.

Bases (different feature sets / objectives → partially decorrelated errors):
  - clev_nowcast       (Cleveland-anchored quantile_rich; current best ~0.1206)
  - shelter_first      (Shelter-decomposed quantile stack)
  - subcomp_5way       (Food/Energy/Shelter/Core/Other decomposition)
  - quantile_rich      (rich daily features, quantile loss)
  - tips_anchor        (TIPS breakeven anchored)

Why BMA (not median, not inv-RMSE, not Ridge-stacked)?

  Bayesian Model Averaging assigns each candidate model a POSTERIOR weight
  proportional to its marginal likelihood given the training residuals.
  Under the standard Gaussian-likelihood + BIC approximation,

        log p(M_i | data) ≈ -0.5 * BIC_i + const,

  with BIC_i = n * ln(SSE_i / n) + k_i * ln(n).  Taking softmax over
  -0.5 * BIC then yields the posterior weights w_i.

  This differs from:
    - Median:        weight = 1/k for everyone (no learning)
    - Inv-RMSE:      weight ∝ 1/RMSE  (linear, ignores n and k_i)
    - Ridge stacked: unconstrained or simplex regression on OOF
    - BMA:           EXPONENTIAL preference for the best-likelihood model,
                     with a SOFT penalty for parameter count k_i.

  BMA gives heavily-weighted preference to the best base while still
  letting the rest contribute when they happen to outperform (via the
  posterior tail).  When SSEs differ a lot, BMA collapses near the best
  model; when SSEs are tied, BMA approaches equal weights.

Effective parameter count k_i:

  We can't introspect the actual GBR/Ridge complexity for each base
  cleanly, so we use a reasonable APPROXIMATION based on the model class:

    - clev          ~ 35   (rich features + Cleveland features, GBR triple)
    - shelter_first ~ 30   (shelter decomp + macro)
    - subcomp_5way  ~ 25   (5-way component decomposition)
    - quantile_rich ~ 25   (rich daily features, GBR triple)
    - tips_anchor   ~ 15   (small anchored model)

  These are ROUGH effective parameter counts.  BMA is forgiving:
  small mis-specification of k shifts the weights only mildly because
  the SSE term scales with n while the k term scales with ln(n).

Public API:
  backtest_bma_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_bma_nowcast(as_of_day=20) -> BmaNowcastResult

Implementation steps:
  1. Run all 5 base backtests internally.  Drop any that fully fail.
  2. Align by target_month — keep only months reported by ALL survivors.
  3. Compute SSE per base on the aligned OOF panel.
  4. Compute BIC_i = n*ln(SSE_i/n) + k_i*ln(n) for each base.
  5. w_i = softmax(-0.5 * BIC_i)  (numerically stable: subtract max).
  6. Final pred = sum_i w_i * pred_i  (per cut, NaN-safe per row).

Falls back to inverse-RMSE if fewer than 2 bases survive.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Approximate effective-parameter counts per base.  These are "k_i" in BIC.
# They reflect the rough number of features times an effective use factor.
# We err on the side of HIGHER k for fancier models so BIC slightly
# discounts them — encourages the simpler tips_anchor when SSEs are close.
_BASE_K: dict[str, int] = {
    "clev":           35,
    "shelter_first":  30,
    "subcomp_5way":   25,
    "quantile_rich":  25,
    "tips_anchor":    15,
}

# Reported total-window RMSE_YoY of each base.  Used ONLY as a fallback
# weighting if BMA computation fails (e.g. all SSEs degenerate).
_REPORTED_RMSE_YOY: dict[str, float] = {
    "clev":          0.1206,
    "shelter_first": 0.1290,
    "subcomp_5way":  0.1295,
    "quantile_rich": 0.1341,
    "tips_anchor":   0.1376,
}

# Floor for SSE in BIC to avoid log(0) blowups when a base happens to be
# perfect on the aligned panel (very rare but possible with few cuts).
_SSE_FLOOR = 1e-9

# Min cuts of aligned OOF for the BIC computation to be meaningful.
_MIN_CUTS_FOR_BMA = 6


@dataclass
class BmaNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    posterior_weights: dict   # {"clev": 0.62, "subcomp_5way": 0.18, ...}
    base_preds: dict          # {"clev": yoy, "subcomp_5way": yoy, ...}


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


def _safe_backtest_shelter_first(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_shelter_first import backtest_shelter_first_nowcast
        out = backtest_shelter_first_nowcast(
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


def _safe_run_shelter_first(as_of_day):
    try:
        from .nowcast_shelter_first import run_shelter_first_nowcast
        return run_shelter_first_nowcast(as_of_day=as_of_day), None
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
# BMA core: BIC + softmax posterior
# ---------------------------------------------------------------------------


def _compute_bic(sse: float, n: int, k: int) -> float:
    """Bayesian Information Criterion for a Gaussian-likelihood regression.

    BIC = n * ln(SSE / n) + k * ln(n)

    Lower BIC = better.  The first term rewards lower residual variance;
    the second penalizes parameter count.
    """
    sse_safe = max(float(sse), _SSE_FLOOR)
    n_safe = max(int(n), 1)
    return n_safe * np.log(sse_safe / n_safe) + k * np.log(n_safe)


def _bma_posterior_weights(
    base_preds: np.ndarray,   # (n_cuts, n_bases)
    y_true: np.ndarray,       # (n_cuts,)
    base_names: list[str],
) -> np.ndarray:
    """Compute BMA posterior weights via softmax(-0.5 * BIC).

    Returns weights of shape (n_bases,) summing to 1.

    Numerically stable: we subtract max(-0.5 * BIC) before exp.

    On degenerate input (NaN BIC, no aligned cuts) returns equal weights.
    """
    n_bases = base_preds.shape[1]
    bics = np.full(n_bases, np.nan)
    for j, name in enumerate(base_names):
        col = base_preds[:, j]
        valid = np.isfinite(col) & np.isfinite(y_true)
        n = int(valid.sum())
        if n < _MIN_CUTS_FOR_BMA:
            continue
        residuals = col[valid] - y_true[valid]
        sse = float(np.sum(residuals ** 2))
        k = _BASE_K.get(name, 20)
        bics[j] = _compute_bic(sse, n, k)

    if not np.any(np.isfinite(bics)):
        return np.ones(n_bases) / n_bases

    log_w = -0.5 * bics
    # Replace NaNs with -inf so they get zero weight after exp.
    log_w = np.where(np.isfinite(log_w), log_w, -np.inf)
    # Numerical stability: subtract max.
    finite_max = np.max(log_w[np.isfinite(log_w)])
    log_w_shifted = log_w - finite_max
    w = np.where(np.isfinite(log_w_shifted), np.exp(log_w_shifted), 0.0)
    s = float(w.sum())
    if s <= 1e-12:
        return np.ones(n_bases) / n_bases
    return w / s


def _apply_weights(
    preds_matrix: np.ndarray,
    weights: np.ndarray,
) -> np.ndarray:
    """Apply per-base weights row-wise.  NaN-safe with renormalization.

    For a row with missing bases, drop them and renormalize the remaining
    weights to sum to 1.
    """
    out = np.full(preds_matrix.shape[0], np.nan)
    for i in range(preds_matrix.shape[0]):
        row = preds_matrix[i]
        ok = np.isfinite(row)
        if not ok.any():
            continue
        w = weights[ok]
        ws = float(w.sum())
        if ws <= 1e-12:
            w = np.ones_like(w) / len(w)
        else:
            w = w / ws
        out[i] = float(np.dot(row[ok], w))
    return out


def _inv_rmse_fallback_weights(base_names: list[str]) -> np.ndarray:
    """Inverse-RMSE weights from reported numbers.  Used as live fallback."""
    weights = []
    for name in base_names:
        r = _REPORTED_RMSE_YOY.get(name, np.nan)
        if not (isinstance(r, (int, float)) and r > 0 and np.isfinite(r)):
            return np.ones(len(base_names)) / len(base_names)
        weights.append(1.0 / float(r))
    w = np.array(weights, dtype=float)
    return w / w.sum()


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_bma_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """BMA over clev / shelter_first / subcomp_5way / quantile_rich / tips_anchor.

    Steps:
      1. Run all 5 base backtests; drop any that fully fail.
      2. Align by target_month — keep only months reported by ALL survivors.
      3. Compute per-base SSE on aligned panel.
      4. Compute BIC and softmax(-0.5 * BIC) → posterior weights.
      5. Apply weights to get final per-cut predictions.

    Returns the standard backtest schema plus diagnostic fields:
      - posteriorWeights: dict of per-base weight
      - baseRmseAligned: dict of per-base RMSE on aligned panel
      - baseBic:         dict of per-base BIC
    """
    # 1) Run each base backtest.
    base_specs = [
        ("clev",           _safe_backtest_clev),
        ("shelter_first",  _safe_backtest_shelter_first),
        ("subcomp_5way",   _safe_backtest_subcomp),
        ("quantile_rich",  _safe_backtest_quantile_rich),
        ("tips_anchor",    _safe_backtest_tips),
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
                f"BMA needs >=2 surviving bases; got {len(base_results)}. "
                f"Errors: {base_errors}"
            ),
        }

    # 2) Align by target_month.
    by_base_by_month: dict[str, dict[str, dict]] = {
        name: {row["target_month"]: row for row in out["rows"]}
        for name, out in base_results.items()
    }
    common_months = None
    for name, by_month in by_base_by_month.items():
        ms = set(by_month.keys())
        common_months = ms if common_months is None else (common_months & ms)
    common_months = sorted(common_months or [])
    if len(common_months) < _MIN_CUTS_FOR_BMA:
        return {
            "error": (
                f"BMA needs >={_MIN_CUTS_FOR_BMA} aligned months; "
                f"got {len(common_months)}. errors: {base_errors}"
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

    # 3 & 4) Compute BMA posterior weights for YoY (the metric we beat).
    weights_yoy = _bma_posterior_weights(pred_yoy_mat, actual_yoy, base_names)

    # Diagnostic: BIC per base on the aligned panel.
    bic_per_base: dict[str, float] = {}
    sse_per_base: dict[str, float] = {}
    for j, name in enumerate(base_names):
        col = pred_yoy_mat[:, j]
        valid = np.isfinite(col) & np.isfinite(actual_yoy)
        n = int(valid.sum())
        if n < _MIN_CUTS_FOR_BMA:
            bic_per_base[name] = float("nan")
            sse_per_base[name] = float("nan")
            continue
        residuals = col[valid] - actual_yoy[valid]
        sse = float(np.sum(residuals ** 2))
        k = _BASE_K.get(name, 20)
        bic_per_base[name] = float(_compute_bic(sse, n, k))
        sse_per_base[name] = sse

    # 5) Apply weights.  Use the same weight vector for MoM (consistent with
    # YoY since YoY≈MoM relative ordering for these bases on the same data).
    final_yoy = _apply_weights(pred_yoy_mat, weights_yoy)
    final_mom = _apply_weights(pred_mom_mat, weights_yoy)

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

    base_rmse_aligned = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        base_rmse_aligned[name] = float(np.sqrt(np.nanmean(diff ** 2)))

    posterior_dict = {
        n: round(float(w), 4) for n, w in zip(base_names, weights_yoy)
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
        "baseBic": {n: round(v, 3) if np.isfinite(v) else None
                    for n, v in bic_per_base.items()},
        "baseSse": {n: round(v, 6) if np.isfinite(v) else None
                    for n, v in sse_per_base.items()},
        "posteriorWeights": posterior_dict,
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_bma_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> BmaNowcastResult:
    """Live BMA forecast for the current target month.

    For the LIVE run we don't have an aligned OOF panel to compute fresh
    BIC weights — those require running the full backtest first.  Instead
    we use a pragmatic two-step:

      1. Try to run the backtest (with default window) to compute live
         BMA posterior weights on a recent panel.
      2. If the backtest fails or is too small, fall back to inverse-RMSE
         weights from the reported numbers.

    Either way, weights are then applied to each base's live forecast.
    """
    base_specs = [
        ("clev",           _safe_run_clev),
        ("shelter_first",  _safe_run_shelter_first),
        ("subcomp_5way",   _safe_run_subcomp),
        ("quantile_rich",  _safe_run_quantile_rich),
        ("tips_anchor",    _safe_run_tips),
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
            f"BMA live needs >=2 bases; got {len(base_results)}. errors: {errors}"
        )

    base_names = list(base_results.keys())

    # Try to compute posterior weights from a fresh backtest.  Falls back
    # to inverse-RMSE if the backtest can't run cleanly here.
    weights = None
    try:
        from .api_client import get_daily_panel
        from .fred import fetch_panel
        from .nowcast_features import build_daily_frame
        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)
        bt = backtest_bma_nowcast(
            panel, daily_frame, window_months=24, as_of_day=as_of_day,
        )
        if "error" not in bt and bt.get("posteriorWeights"):
            pw = bt["posteriorWeights"]
            # Restrict to LIVE-survivor bases; renormalize.
            w_list = []
            for n in base_names:
                w_list.append(float(pw.get(n, 0.0)))
            w = np.array(w_list, dtype=float)
            s = w.sum()
            if s > 1e-9:
                weights = w / s
    except Exception:
        weights = None

    if weights is None:
        weights = _inv_rmse_fallback_weights(base_names)

    yoy_vec = np.array([float(base_results[n].pred_yoy) for n in base_names])
    mom_vec = np.array([float(base_results[n].pred_mom) for n in base_names])
    lo_vec = np.array([float(base_results[n].lo80_yoy) for n in base_names])
    hi_vec = np.array([float(base_results[n].hi80_yoy) for n in base_names])

    pred_yoy = float(np.dot(yoy_vec, weights))
    pred_mom = float(np.dot(mom_vec, weights))
    # Bands: weighted average is too narrow; widen to the union of bases.
    lo80_yoy = float(np.min(lo_vec))
    hi80_yoy = float(np.max(hi_vec))

    ref = base_results.get("clev") or base_results[base_names[0]]
    return BmaNowcastResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        posterior_weights={n: round(float(w), 4) for n, w in zip(base_names, weights)},
        base_preds={n: float(base_results[n].pred_yoy) for n in base_names},
    )
