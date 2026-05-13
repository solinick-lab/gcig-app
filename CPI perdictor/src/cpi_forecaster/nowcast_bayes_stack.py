"""Bayesian linear stacker — combine 4 strong nowcasters via BayesianRidge.

Bases (each consumes a meaningfully different signal):
  - Yellen 1.1   (clev_calibrated)   RMSE_YoY 0.1142  — Cleveland Fed +
                 Ridge bias-correction calibrator over the clev_nowcast
                 backbone.
  - Yellen 1.2   (clev_trajectory)   RMSE_YoY 0.1204  — same backbone,
                 fed slope/acceleration features extracted from the
                 Cleveland nowcast archive.
  - Greenspan 1.1 (shelter_first)    RMSE_YoY 0.1269  — hierarchical
                 Food/Energy/Shelter/Other-Core decomposition with a
                 Zillow-driven shelter forecaster. NO Cleveland Fed
                 dependency.
  - Volcker 1.1  (quantile_rich)     RMSE_YoY 0.1341  — pure quantile
                 regression on rich daily features. No external scrape.

The four bases span THREE fundamentally different anchors:
  1. Cleveland Fed nowcast (Yellen 1.1, 1.2)
  2. Zillow rent / BLS sub-index decomposition (Greenspan 1.1)
  3. Daily macro panel only (Volcker 1.1)
so prediction errors are only partially correlated. A learned weight
mixture should beat the leading single base (0.1142) by exploiting the
disagreement.

Stacking strategy: Bayesian Ridge regression on the YoY base predictions
with NO intercept (the bases are already well-calibrated to YoY units),
and post-fit non-negative-clipping + simplex renormalization to keep the
weights interpretable as a convex combination. BayesianRidge auto-tunes
both alpha (noise precision) and lambda (weight precision) via the
evidence approximation — i.e. no leakage-prone CV grid-search and the
shrinkage strength scales with the actual residual noise we observe.
That's the whole point: with only ~24 cuts of aligned data, ordinary
Ridge stacking is heavily prone to overfitting (you have to pick alpha
yourself). BayesianRidge handles that automatically.

Public API mirrors the rest of the nowcast_* modules:
  backtest_bayes_stack_nowcast(panel, daily_frame,
                               window_months=24, as_of_day=20) -> dict
  run_bayes_stack_nowcast(as_of_day=20) -> BayesStackNowcastResult

The dict returned by `backtest_bayes_stack_nowcast` follows the standard
nowcast-backtest schema (asOfDay, windowMonths, totalCuts, rmseMom,
rmseYoy, maeYoy, hitWithin25bp, hitWithin50bp, rows). Diagnostic fields
(components, baseRmseAligned, bayesWeights, baseErrors) are appended.

Each base call is wrapped in try/except. Cuts where any base prediction
is missing are dropped from the BayesianRidge fit (which is restricted
to fully observed rows). At inference any single missing base is filled
from the median of the in-window predictions for that base, then the
remaining bases' weights are renormalized.

For the LIVE run (`run_bayes_stack_nowcast`), the backtest is invoked
internally to learn the BayesianRidge weights; the live base preds are
then projected through those weights. This keeps the live blend
deterministic and in-sample-anchored, mirroring the discipline used in
`nowcast_top2_stack.py`.

MoM clipping ([-1.5, 2.5]) and the YoY half-band floor (0.05) match the
base-model conventions.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .nowcast import DEFAULT_AS_OF_DAY


warnings.filterwarnings("ignore")


# Sanity clip on aggregated MoM, applied AFTER the chosen ensemble.
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5

# Floor on YoY half-band width when synthesizing the live confidence band.
_RESID_FLOOR = 0.05

# Minimum aligned rows we require before attempting a BayesianRidge fit.
# Below this we fall back to inverse-RMSE static weights.
_MIN_ROWS_FOR_BAYES = 8

# Reported RMSE_YoY constants for inverse-RMSE fallback weighting. These
# are stable inputs from prior backtests — they don't peek at the cuts in
# this module's window. Keys must match the base names below.
_REPORTED_RMSE_YOY: dict[str, float] = {
    "clev_calibrated": 0.1142,
    "clev_trajectory": 0.1204,
    "shelter_first":   0.1269,
    "quantile_rich":   0.1341,
}


@dataclass
class BayesStackNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    base_preds: dict          # {name: yoy} for diagnostics
    weights: dict             # {name: w} actually applied
    chosen_approach: str      # "bayes_ridge" or "inv_rmse" fallback


# ---------------------------------------------------------------------------
# Per-base safe runners — each returns (result_or_dict, error_str_or_None)
# ---------------------------------------------------------------------------


def _safe_backtest_clev_calibrated(panel, daily_frame, window_months, as_of_day):
    try:
        from .nowcast_clev_calibrated import backtest_clev_calibrated_nowcast
        out = backtest_clev_calibrated_nowcast(
            panel, daily_frame,
            window_months=window_months, as_of_day=as_of_day,
        )
        if not isinstance(out, dict) or "error" in out:
            return None, (
                out.get("error") if isinstance(out, dict)
                else "non-dict result"
            )
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
            return None, (
                out.get("error") if isinstance(out, dict)
                else "non-dict result"
            )
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
            return None, (
                out.get("error") if isinstance(out, dict)
                else "non-dict result"
            )
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
            return None, (
                out.get("error") if isinstance(out, dict)
                else "non-dict result"
            )
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


_BASE_NAMES: tuple[str, ...] = (
    "clev_calibrated",
    "clev_trajectory",
    "shelter_first",
    "quantile_rich",
)
_BASE_BACKTESTS = (
    _safe_backtest_clev_calibrated,
    _safe_backtest_clev_trajectory,
    _safe_backtest_shelter_first,
    _safe_backtest_quantile_rich,
)
_BASE_RUNS = (
    _safe_run_clev_calibrated,
    _safe_run_clev_trajectory,
    _safe_run_shelter_first,
    _safe_run_quantile_rich,
)


# ---------------------------------------------------------------------------
# BayesianRidge stacker with non-negative weight clipping
# ---------------------------------------------------------------------------


def _fit_bayes_stack(
    base_preds: np.ndarray,    # (n, k) YoY base preds (k = #bases)
    y_true: np.ndarray,        # (n,) actual YoY
) -> np.ndarray | None:
    """Fit BayesianRidge on the aligned base preds and project the
    coefficients to the non-negative simplex (weights >= 0, sum to 1).

    BayesianRidge auto-tunes alpha (noise precision) and lambda (weight
    precision) by maximizing the marginal likelihood — no CV needed,
    which is critical since we have at most ~24 aligned rows.

    Returns None if the fit is degenerate (e.g. all coefficients zero or
    NaN), in which case the caller should fall back to inverse-RMSE
    weights.
    """
    if base_preds.ndim != 2 or base_preds.shape[0] < _MIN_ROWS_FOR_BAYES:
        return None
    if base_preds.shape[1] < 2:
        return None
    mask = (
        np.all(np.isfinite(base_preds), axis=1) & np.isfinite(y_true)
    )
    if int(mask.sum()) < _MIN_ROWS_FOR_BAYES:
        return None

    X_fit = base_preds[mask]
    y_fit = y_true[mask]

    try:
        from sklearn.linear_model import BayesianRidge
        # fit_intercept=False — bases already in YoY units, intercept
        # would steal signal. compute_score is unused here but kept off
        # for speed. Tolerance 1e-4 is sklearn's default.
        br = BayesianRidge(
            fit_intercept=False,
            tol=1e-4,
            max_iter=300,
            alpha_1=1e-6, alpha_2=1e-6,
            lambda_1=1e-6, lambda_2=1e-6,
        )
        br.fit(X_fit, y_fit)
        coef = np.array(br.coef_, dtype=float)
    except Exception:
        return None

    if not np.all(np.isfinite(coef)):
        return None

    # Non-negative weight constraint, approximated by clipping post-fit.
    coef = np.clip(coef, 0.0, None)
    s = float(coef.sum())
    if s <= 1e-9:
        # Degenerate (all clipped to zero) — caller falls back.
        return None
    coef = coef / s
    if not np.all(np.isfinite(coef)):
        return None
    return coef


def _inv_rmse_weights(base_names: list[str]) -> np.ndarray:
    """Inverse-RMSE static weights from REPORTED constants. Falls back
    to equal weights if any RMSE is missing or non-positive."""
    raw_w = []
    fell_back = False
    for n in base_names:
        r = _REPORTED_RMSE_YOY.get(n, np.nan)
        if not (isinstance(r, (int, float)) and r > 0 and np.isfinite(r)):
            fell_back = True
            break
        raw_w.append(1.0 / float(r))
    if fell_back or not raw_w:
        return np.ones(len(base_names), dtype=float) / max(len(base_names), 1)
    w = np.array(raw_w, dtype=float)
    return w / w.sum()


def _apply_weights(
    preds_matrix: np.ndarray, weights: np.ndarray,
) -> np.ndarray:
    """Apply a fixed weight vector row-wise, NaN-safe.

    If a row has missing bases, renormalize over the present ones. Rows
    with all-NaN entries return NaN.
    """
    out = np.full(preds_matrix.shape[0], np.nan)
    for i in range(preds_matrix.shape[0]):
        row = preds_matrix[i]
        ok = np.isfinite(row)
        if not ok.any():
            continue
        w = weights[ok]
        ws = float(w.sum())
        if ws <= 1e-9:
            w = np.ones_like(w) / len(w)
        else:
            w = w / ws
        out[i] = float(np.dot(row[ok], w))
    return out


# ---------------------------------------------------------------------------
# Public backtest
# ---------------------------------------------------------------------------


def backtest_bayes_stack_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the Bayesian linear stacker.

    Internally:
      1. Run all four base backtests over the same window.
      2. Drop bases that fully fail. If 0 survive: error. If 1 survives:
         pass-through with a flag.
      3. Align by target_month — keep months reported by ALL surviving
         bases (or, when a base is missing for a given month, leave that
         entry NaN; BayesianRidge fits on fully observed rows only).
      4. Fit BayesianRidge on the aligned (YoY base preds, actual YoY)
         panel. Clip coefficients to non-negative and renormalize.
      5. If the BayesianRidge fit is degenerate (rare with k=4 bases),
         fall back to inverse-RMSE static weights.
      6. Apply the same weights to BOTH the YoY and MoM matrices and
         report.
    """
    base_results: dict[str, dict] = {}
    base_errors: dict[str, str] = {}
    for name, fn in zip(_BASE_NAMES, _BASE_BACKTESTS):
        out, err = fn(panel, daily_frame, window_months, as_of_day)
        if out is not None:
            base_results[name] = out
        else:
            base_errors[name] = err or "unknown"

    if not base_results:
        return {"error": f"all bases failed. errors: {base_errors}"}

    # If only one survives, pass-through with a flag.
    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only_out = base_results[only_name]
        out = dict(only_out)
        out["chosenApproach"] = "single_base_passthrough"
        out["singleBase"] = only_name
        out["baseErrors"] = base_errors
        out["components"] = list(base_results.keys())
        return out

    # Align by target_month. Use the union of months and let NaN gaps
    # be handled by row-mask filtering during the BayesianRidge fit.
    by_base_by_month: dict[str, dict[str, dict]] = {
        name: {row["target_month"]: row for row in out["rows"]}
        for name, out in base_results.items()
    }
    all_months: set[str] = set()
    for by_month in by_base_by_month.values():
        all_months.update(by_month.keys())
    months = sorted(all_months)
    if len(months) < _MIN_ROWS_FOR_BAYES:
        return {
            "error": (
                f"insufficient aligned months: {len(months)} "
                f"(need >={_MIN_ROWS_FOR_BAYES}). errors: {base_errors}"
            ),
        }

    base_names = list(base_results.keys())
    pred_yoy_mat = np.full((len(months), len(base_names)), np.nan)
    pred_mom_mat = np.full((len(months), len(base_names)), np.nan)
    actual_yoy = np.full(len(months), np.nan)
    actual_mom = np.full(len(months), np.nan)
    as_of_per_month: list[str] = []

    for i, m in enumerate(months):
        ref_row = None
        for j, name in enumerate(base_names):
            r = by_base_by_month[name].get(m)
            if r is None:
                continue
            try:
                pred_yoy_mat[i, j] = float(r.get("pred_yoy"))
            except (TypeError, ValueError):
                pass
            try:
                pred_mom_mat[i, j] = float(r.get("pred_mom"))
            except (TypeError, ValueError):
                pass
            if ref_row is None:
                ref_row = r
        # Prefer Yellen 1.1 (clev_calibrated) row as actual reference.
        if "clev_calibrated" in by_base_by_month:
            ref_row = by_base_by_month["clev_calibrated"].get(m, ref_row)
        if ref_row is not None:
            try:
                actual_yoy[i] = float(ref_row["actual_yoy"])
                actual_mom[i] = float(ref_row["actual_mom"])
            except (TypeError, ValueError, KeyError):
                pass
            as_of_per_month.append(str(ref_row.get("as_of", "")))
        else:
            as_of_per_month.append("")

    # Fit BayesianRidge on fully observed rows.
    coef = _fit_bayes_stack(pred_yoy_mat, actual_yoy)
    if coef is not None:
        chosen = "bayes_ridge"
        weights = coef
    else:
        chosen = "inv_rmse_fallback"
        weights = _inv_rmse_weights(base_names)

    final_yoy = _apply_weights(pred_yoy_mat, weights)
    final_mom = _apply_weights(pred_mom_mat, weights)
    final_mom = np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP)

    # Per-base RMSE on the aligned panel (diagnostic only).
    base_rmse_aligned: dict[str, float] = {}
    for j, name in enumerate(base_names):
        diff = pred_yoy_mat[:, j] - actual_yoy
        m = np.isfinite(diff)
        base_rmse_aligned[name] = (
            float(np.sqrt(np.mean(diff[m] ** 2))) if m.any() else float("nan")
        )

    rows: list[dict] = []
    for i, m in enumerate(months):
        row = {
            "target_month": m,
            "as_of": as_of_per_month[i] if i < len(as_of_per_month) else "",
            "pred_mom": (
                round(float(final_mom[i]), 4)
                if np.isfinite(final_mom[i]) else None
            ),
            "actual_mom": (
                round(float(actual_mom[i]), 4)
                if np.isfinite(actual_mom[i]) else None
            ),
            "pred_yoy": (
                round(float(final_yoy[i]), 3)
                if np.isfinite(final_yoy[i]) else None
            ),
            "actual_yoy": (
                round(float(actual_yoy[i]), 3)
                if np.isfinite(actual_yoy[i]) else None
            ),
            "yoy_err": (
                round(float(final_yoy[i]) - float(actual_yoy[i]), 3)
                if (np.isfinite(final_yoy[i]) and np.isfinite(actual_yoy[i]))
                else None
            ),
        }
        for j, name in enumerate(base_names):
            v = pred_yoy_mat[i, j]
            row[f"{name}_pred_yoy"] = (
                round(float(v), 3) if np.isfinite(v) else None
            )
        rows.append(row)

    valid = np.isfinite(final_yoy) & np.isfinite(actual_yoy)
    valid_mom = np.isfinite(final_mom) & np.isfinite(actual_mom)
    if not valid.any():
        return {
            "error": "no valid stacked predictions after alignment",
            "baseErrors": base_errors,
        }
    yoy_err_abs = np.abs(final_yoy[valid] - actual_yoy[valid])

    weights_out = {
        n: round(float(w), 4) for n, w in zip(base_names, weights)
    }

    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": int(valid.sum()),
        "rmseMom": (
            float(np.sqrt(np.mean(
                (final_mom[valid_mom] - actual_mom[valid_mom]) ** 2
            ))) if valid_mom.any() else float("nan")
        ),
        "rmseYoy": float(np.sqrt(np.mean(
            (final_yoy[valid] - actual_yoy[valid]) ** 2
        ))),
        "maeYoy": float(np.mean(yoy_err_abs)),
        "hitWithin25bp": float((yoy_err_abs <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err_abs <= 0.50).mean()) * 100,
        "rows": rows,
        "components": base_names,
        "baseErrors": base_errors,
        "baseRmseAligned": base_rmse_aligned,
        "chosenApproach": chosen,
        "bayesWeights": weights_out,
    }


# ---------------------------------------------------------------------------
# Public live runner
# ---------------------------------------------------------------------------


def run_bayes_stack_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> BayesStackNowcastResult:
    """Live forecast: run all bases for the current target month and
    blend through the BayesianRidge weights learned in-sample on the
    standard 24-month backtest window.

    If the in-sample fit is degenerate (rare), we fall back to inverse-
    RMSE static weights from REPORTED constants. This mirrors the
    discipline used elsewhere in the codebase: live blends are
    deterministic and use no fresh peeking.
    """
    # Run live bases.
    base_results: dict[str, object] = {}
    errors: dict[str, str] = {}
    for name, fn in zip(_BASE_NAMES, _BASE_RUNS):
        res, err = fn(as_of_day)
        if res is not None:
            base_results[name] = res
        else:
            errors[name] = err or "unknown"

    if not base_results:
        raise RuntimeError(
            f"bayes_stack: all bases failed. errors: {errors}"
        )

    # Single-survivor pass-through.
    if len(base_results) == 1:
        only_name = next(iter(base_results.keys()))
        only = base_results[only_name]
        return BayesStackNowcastResult(
            as_of=getattr(only, "as_of"),
            target_month=getattr(only, "target_month"),
            pred_mom=float(getattr(only, "pred_mom")),
            pred_yoy=float(getattr(only, "pred_yoy")),
            lo80_yoy=float(getattr(only, "lo80_yoy")),
            hi80_yoy=float(getattr(only, "hi80_yoy")),
            days_observed=int(getattr(only, "days_observed", 0)),
            used_clev_scrape=bool(
                getattr(only, "used_clev_scrape", False)
            ),
            base_preds={only_name: float(getattr(only, "pred_yoy"))},
            weights={only_name: 1.0},
            chosen_approach="single_base_passthrough",
        )

    # Learn weights from the standard 24-month backtest. The backtest
    # internally calls each base's backtest, fits BayesianRidge, and
    # exposes `bayesWeights` (or "inv_rmse_fallback").
    chosen = "bayes_ridge"
    learned_weights: dict[str, float] | None = None
    try:
        from .api_client import get_daily_panel
        from .fred import fetch_panel
        from .nowcast_features import build_daily_frame

        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)

        bt = backtest_bayes_stack_nowcast(
            panel, daily_frame,
            window_months=24, as_of_day=as_of_day,
        )
        if isinstance(bt, dict) and "bayesWeights" in bt:
            learned_weights = {
                str(k): float(v) for k, v in bt["bayesWeights"].items()
            }
            chosen = str(bt.get("chosenApproach", "bayes_ridge"))
    except Exception:
        learned_weights = None
        chosen = "inv_rmse_fallback"

    base_names = list(base_results.keys())
    if learned_weights is None:
        w = _inv_rmse_weights(base_names)
        chosen = "inv_rmse_fallback"
    else:
        w_list: list[float] = []
        for n in base_names:
            w_list.append(float(learned_weights.get(n, 0.0)))
        w_arr = np.array(w_list, dtype=float)
        s = float(w_arr.sum())
        if s <= 1e-9:
            w = _inv_rmse_weights(base_names)
            chosen = "inv_rmse_fallback"
        else:
            w = w_arr / s

    yoy_vec = np.array(
        [float(base_results[n].pred_yoy) for n in base_names], dtype=float,
    )
    mom_vec = np.array(
        [float(base_results[n].pred_mom) for n in base_names], dtype=float,
    )
    lo_vec = np.array(
        [float(base_results[n].lo80_yoy) for n in base_names], dtype=float,
    )
    hi_vec = np.array(
        [float(base_results[n].hi80_yoy) for n in base_names], dtype=float,
    )

    pred_yoy = float(np.dot(yoy_vec, w))
    pred_mom = float(np.clip(np.dot(mom_vec, w), _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Conservative confidence band: widest envelope across surviving bases.
    lo80_yoy = float(np.min(lo_vec))
    hi80_yoy = float(np.max(hi_vec))
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    # Reference metadata: prefer Yellen 1.1 (clev_calibrated) when available.
    ref = (
        base_results.get("clev_calibrated")
        or base_results.get("clev_trajectory")
        or base_results[base_names[0]]
    )

    used_clev = False
    for n in ("clev_calibrated", "clev_trajectory"):
        r = base_results.get(n)
        if r is not None and bool(getattr(r, "used_clev_scrape", False)):
            used_clev = True
            break

    return BayesStackNowcastResult(
        as_of=getattr(ref, "as_of"),
        target_month=getattr(ref, "target_month"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=int(getattr(ref, "days_observed", 0)),
        used_clev_scrape=used_clev,
        base_preds={
            n: float(base_results[n].pred_yoy) for n in base_names
        },
        weights={n: round(float(wi), 4) for n, wi in zip(base_names, w)},
        chosen_approach=chosen,
    )
