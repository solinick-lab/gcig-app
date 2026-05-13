"""Model-selector nowcaster — pick the single best of 4 candidates per cut.

Strategy: not an ensemble (no blending). For every monthly cut, evaluate the
trailing 6-month MAE of each candidate model on its own walk-forward
backtest history (rows strictly BEFORE the cut, so no leakage), then pick
the lowest-MAE model and use ONLY its prediction for that cut. Idea: model
performance is regime-dependent — Volcker 1.1 (quantile_rich) wins in noisy
months, Yellen 1.1 (clev_calibrated) wins when Cleveland's nowcast is
well-calibrated, Greenspan 1.1 (shelter_first) wins when housing dominates,
and Yellen 1.2 (clev_trajectory) wins when momentum is the signal. Letting
the data choose dynamically per cut should beat any fixed-weight ensemble
that has to commit to one mixture across all regimes.

Candidate set:
  - Yellen 1.1   (nowcast_clev_calibrated)
  - Yellen 1.2   (nowcast_clev_trajectory)
  - Greenspan 1.1 (nowcast_shelter_first)
  - Volcker 1.1  (nowcast_quantile_rich)

Selection rule per cut at time t:
  for each model m:
      mae_6m[m] = mean(|pred_yoy_m(s) - actual_yoy(s)|) over last 6
                  successful backtest rows of m with s < t
  picked  = argmin mae_6m[m]   (ties broken by registry order:
                                Yellen 1.1 → Yellen 1.2 → Greenspan 1.1 → Volcker 1.1)
  output  = picked-model's row for cut t (verbatim — no blending)

Cold start: if any cut has fewer than 6 prior rows for ALL models, fall back
to picking the model with the smallest prior absolute YoY error mean over
whatever rows exist; if no prior rows exist for any model on that cut, fall
back to Yellen 1.1 (current production champion).

Public API (standard interface):
  backtest_selector_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_selector_nowcast(as_of_day=20) -> SelectorNowcastResult

Same return-dict keys as nowcast.backtest_nowcast: rmseMom, rmseYoy, maeYoy,
hitWithin25bp, hitWithin50bp, totalCuts, asOfDay, windowMonths, rows.
Each row carries a `picked_model` field plus the per-model trailing MAEs
(`mae6_*`) so the picks are auditable.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame

from .nowcast_clev_calibrated import (
    backtest_clev_calibrated_nowcast,
    run_clev_calibrated_nowcast,
)
from .nowcast_clev_trajectory import (
    backtest_clev_trajectory_nowcast,
    run_clev_trajectory_nowcast,
)
from .nowcast_shelter_first import (
    backtest_shelter_first_nowcast,
    run_shelter_first_nowcast,
)
from .nowcast_quantile_rich import (
    backtest_quantile_rich_nowcast,
    run_quantile_rich_nowcast,
)


warnings.filterwarnings("ignore")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Order matters: ties are broken by this order (Yellen 1.1 first as the
# current production champion).
_MODEL_NAMES: tuple[str, ...] = (
    "yellen_1_1",   # clev_calibrated
    "yellen_1_2",   # clev_trajectory
    "greenspan_1_1",  # shelter_first
    "volcker_1_1",  # quantile_rich
)

_MODEL_LABELS: dict[str, str] = {
    "yellen_1_1": "Yellen 1.1",
    "yellen_1_2": "Yellen 1.2",
    "greenspan_1_1": "Greenspan 1.1",
    "volcker_1_1": "Volcker 1.1",
}

_BACKTEST_FNS = {
    "yellen_1_1": backtest_clev_calibrated_nowcast,
    "yellen_1_2": backtest_clev_trajectory_nowcast,
    "greenspan_1_1": backtest_shelter_first_nowcast,
    "volcker_1_1": backtest_quantile_rich_nowcast,
}

_RUN_FNS = {
    "yellen_1_1": run_clev_calibrated_nowcast,
    "yellen_1_2": run_clev_trajectory_nowcast,
    "greenspan_1_1": run_shelter_first_nowcast,
    "volcker_1_1": run_quantile_rich_nowcast,
}

_MAE_WINDOW = 6  # months of prior backtest rows to average abs(YoY error)
_FALLBACK_MODEL = "yellen_1_1"  # cold-start default = current production


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class SelectorNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    picked_model: str
    picked_label: str
    mae6_by_model: dict[str, float | None]
    member_preds_yoy: dict[str, float | None]


# ---------------------------------------------------------------------------
# Internal: per-model prior-MAE computation
# ---------------------------------------------------------------------------


def _trailing_mae(rows: list[dict], target_month_str: str, window: int = _MAE_WINDOW) -> float | None:
    """Mean |pred_yoy - actual_yoy| over the last `window` rows strictly
    BEFORE `target_month_str`. None if no usable rows.

    Rows are sorted ascending by target_month (YYYY-MM) before slicing.
    """
    if not rows:
        return None
    try:
        prior = [r for r in rows if r.get("target_month") and r["target_month"] < target_month_str]
    except Exception:
        return None
    if not prior:
        return None
    prior_sorted = sorted(prior, key=lambda r: r["target_month"])
    tail = prior_sorted[-window:]
    errs = []
    for r in tail:
        try:
            err = abs(float(r["pred_yoy"]) - float(r["actual_yoy"]))
            if np.isfinite(err):
                errs.append(err)
        except (KeyError, TypeError, ValueError):
            continue
    if not errs:
        return None
    return float(np.mean(errs))


def _pick_model(maes: dict[str, float | None]) -> str:
    """Pick lowest-MAE model. Ties broken by `_MODEL_NAMES` order. If every
    model is None (cold-start, no prior history at all), return the
    fallback champion.
    """
    best_name: str | None = None
    best_mae: float = float("inf")
    for name in _MODEL_NAMES:  # registry order = tie-breaker
        m = maes.get(name)
        if m is None:
            continue
        if m < best_mae - 1e-12:
            best_mae = m
            best_name = name
    return best_name if best_name is not None else _FALLBACK_MODEL


# ---------------------------------------------------------------------------
# Backtest
# ---------------------------------------------------------------------------


def backtest_selector_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the per-cut model selector.

    For every cut t in the trailing `window_months`:
      1. Look up each candidate's prediction for t in its own backtest run
         (each candidate's backtest is itself walk-forward, so the
         training data for cut t never includes t).
      2. Compute each candidate's trailing-6-month MAE using ONLY rows
         with target_month < t (no leakage).
      3. Pick the lowest-MAE candidate; emit its row verbatim.

    A cut is skipped if NO candidate produced a row for it. Cold-start
    cuts (no prior history at all) fall back to Yellen 1.1.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    # ------------------------------------------------------------------
    # Step 1: run each candidate's own walk-forward backtest once on the
    # same panel/window. We just need their `rows` lists.
    # ------------------------------------------------------------------
    component_results: dict[str, dict] = {}
    component_rows: dict[str, dict[str, dict]] = {}  # name -> {target_month: row}
    for name in _MODEL_NAMES:
        try:
            r = _BACKTEST_FNS[name](
                panel,
                daily_frame,
                window_months=window_months,
                as_of_day=as_of_day,
            )
        except Exception as e:
            component_results[name] = {"error": f"{type(e).__name__}: {e}"}
            component_rows[name] = {}
            continue
        component_results[name] = r
        if "error" in r:
            component_rows[name] = {}
            continue
        idx: dict[str, dict] = {}
        for row in r.get("rows", []):
            tm = row.get("target_month")
            if tm:
                idx[tm] = row
        component_rows[name] = idx

    # If every component failed there's nothing to do.
    if all(not component_rows[name] for name in _MODEL_NAMES):
        return {"error": "no candidate backtest produced any rows"}

    # ------------------------------------------------------------------
    # Step 2: build the union of months any candidate scored, ordered
    # ascending so the trailing-MAE lookup uses purely past data.
    # ------------------------------------------------------------------
    all_months: set[str] = set()
    for name in _MODEL_NAMES:
        all_months.update(component_rows[name].keys())
    months_sorted = sorted(all_months)

    # ------------------------------------------------------------------
    # Step 3: walk months. For each, compute trailing MAE per model
    # using ONLY component rows with target_month < t.
    # ------------------------------------------------------------------
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []
    pick_counts: dict[str, int] = {n: 0 for n in _MODEL_NAMES}

    for tm in months_sorted:
        try:
            # Trailing-6 MAE per model on rows with target_month < tm.
            maes: dict[str, float | None] = {}
            for name in _MODEL_NAMES:
                model_rows = list(component_rows[name].values())
                maes[name] = _trailing_mae(model_rows, tm, window=_MAE_WINDOW)

            # If nobody has any prior rows, mark as cold-start and use
            # the fallback only if it has a prediction this cut.
            picked = _pick_model(maes)

            # The picked model must actually have a row for this cut. If
            # not, fall back to whichever model scored this cut and has
            # the lowest prior-MAE among those that scored it.
            if picked not in component_rows or tm not in component_rows[picked]:
                # Restrict candidates to those who scored this cut.
                scoring_names = [n for n in _MODEL_NAMES if tm in component_rows[n]]
                if not scoring_names:
                    continue  # no candidate covered this cut — skip
                # Pick lowest-MAE among scorers; ties → registry order.
                best_name: str | None = None
                best_mae: float = float("inf")
                for n in scoring_names:  # already in registry order
                    m = maes.get(n)
                    if m is None:
                        continue
                    if m < best_mae - 1e-12:
                        best_mae = m
                        best_name = n
                if best_name is None:
                    # No prior MAE for any scorer → registry-order fallback
                    best_name = scoring_names[0]
                picked = best_name

            chosen_row = component_rows[picked][tm]

            pred_mom = float(chosen_row["pred_mom"])
            actual_mom = float(chosen_row["actual_mom"])
            pred_yoy = float(chosen_row["pred_yoy"])
            actual_yoy = float(chosen_row["actual_yoy"])
            as_of_str = chosen_row.get("as_of")

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            pick_counts[picked] = pick_counts.get(picked, 0) + 1

            # Per-model member preds for diagnostics on this cut.
            members_yoy: dict[str, float | None] = {}
            for n in _MODEL_NAMES:
                if tm in component_rows[n]:
                    try:
                        members_yoy[n] = round(float(component_rows[n][tm]["pred_yoy"]), 3)
                    except Exception:
                        members_yoy[n] = None
                else:
                    members_yoy[n] = None

            row = {
                "target_month": tm,
                "as_of": as_of_str,
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "picked_model": picked,
                "picked_label": _MODEL_LABELS[picked],
                "mae6_yellen_1_1": (
                    round(maes["yellen_1_1"], 4)
                    if maes["yellen_1_1"] is not None else None
                ),
                "mae6_yellen_1_2": (
                    round(maes["yellen_1_2"], 4)
                    if maes["yellen_1_2"] is not None else None
                ),
                "mae6_greenspan_1_1": (
                    round(maes["greenspan_1_1"], 4)
                    if maes["greenspan_1_1"] is not None else None
                ),
                "mae6_volcker_1_1": (
                    round(maes["volcker_1_1"], 4)
                    if maes["volcker_1_1"] is not None else None
                ),
                "member_preds_yoy": members_yoy,
            }
            rows.append(row)
        except Exception:
            continue

    if not preds_mom:
        return {"error": "selector produced no successful cuts"}

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
        "rows": rows,
        "pickCounts": {_MODEL_LABELS[n]: int(pick_counts.get(n, 0)) for n in _MODEL_NAMES},
        "components": {
            _MODEL_LABELS[n]: {
                "rmseYoy": (
                    component_results[n].get("rmseYoy")
                    if isinstance(component_results.get(n), dict) else None
                ),
                "maeYoy": (
                    component_results[n].get("maeYoy")
                    if isinstance(component_results.get(n), dict) else None
                ),
                "totalCuts": (
                    component_results[n].get("totalCuts")
                    if isinstance(component_results.get(n), dict) else None
                ),
                "error": (
                    component_results[n].get("error")
                    if isinstance(component_results.get(n), dict) else None
                ),
            }
            for n in _MODEL_NAMES
        },
    }


# ---------------------------------------------------------------------------
# Live nowcast
# ---------------------------------------------------------------------------


def run_selector_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SelectorNowcastResult:
    """Live model-selector nowcast.

    1. Pull the panel + daily frame once (used for backtest below).
    2. Run all 4 candidates' live nowcasts to get this month's predictions.
    3. Run all 4 walk-forward backtests on the same panel to get the
       freshest trailing-6-month MAE per model.
    4. Pick the lowest-MAE candidate (ties → registry order; cold-start →
       Yellen 1.1) and return its result verbatim with selector metadata.
    """
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    # ---- Step 2: live predictions per candidate ----
    live_results: dict[str, object] = {}
    for name, fn in _RUN_FNS.items():
        try:
            live_results[name] = fn(as_of_day=as_of_day)
        except Exception as e:
            print(f"[selector] live {_MODEL_LABELS[name]} failed: {e}")
            live_results[name] = None

    # ---- Step 3: trailing MAE from a fresh backtest run ----
    maes: dict[str, float | None] = {}
    for name in _MODEL_NAMES:
        try:
            r = _BACKTEST_FNS[name](
                panel,
                daily_frame,
                window_months=24,
                as_of_day=as_of_day,
            )
            if isinstance(r, dict) and "error" not in r:
                # Use the most recent cut as the cutoff so the MAE is "as
                # of the live forecast moment". Equivalent to picking the
                # last 6 rows of the backtest.
                rows = r.get("rows", [])
                if rows:
                    rows_sorted = sorted(rows, key=lambda x: x.get("target_month", ""))
                    tail = rows_sorted[-_MAE_WINDOW:]
                    errs = []
                    for row in tail:
                        try:
                            errs.append(
                                abs(float(row["pred_yoy"]) - float(row["actual_yoy"]))
                            )
                        except (KeyError, TypeError, ValueError):
                            continue
                    maes[name] = float(np.mean(errs)) if errs else None
                else:
                    maes[name] = None
            else:
                maes[name] = None
        except Exception as e:
            print(f"[selector] backtest {_MODEL_LABELS[name]} failed: {e}")
            maes[name] = None

    # ---- Step 4: pick (ties → registry order; cold start → fallback) ----
    available = {n: maes[n] for n in _MODEL_NAMES if live_results.get(n) is not None}
    if not available:
        raise RuntimeError("All selector candidates failed live nowcast")

    # Pick lowest-MAE among models that succeeded live AND have a MAE.
    best_name: str | None = None
    best_mae: float = float("inf")
    for n in _MODEL_NAMES:  # registry order tie-breaker
        if n not in available:
            continue
        m = available[n]
        if m is None:
            continue
        if m < best_mae - 1e-12:
            best_mae = m
            best_name = n

    if best_name is None:
        # Cold-start: nobody has a MAE. Use fallback if it succeeded live;
        # otherwise first available.
        if _FALLBACK_MODEL in available:
            best_name = _FALLBACK_MODEL
        else:
            best_name = next(iter(available.keys()))

    picked_result = live_results[best_name]

    # Pull common fields off the picked result.
    pred_mom = float(getattr(picked_result, "pred_mom"))
    pred_yoy = float(getattr(picked_result, "pred_yoy"))
    lo80_yoy = float(getattr(picked_result, "lo80_yoy"))
    hi80_yoy = float(getattr(picked_result, "hi80_yoy"))
    as_of = getattr(picked_result, "as_of")
    target_month = getattr(picked_result, "target_month")
    days_observed = int(getattr(picked_result, "days_observed", 0))

    member_preds_yoy: dict[str, float | None] = {}
    for n in _MODEL_NAMES:
        res = live_results.get(n)
        if res is None:
            member_preds_yoy[n] = None
        else:
            try:
                member_preds_yoy[n] = round(float(getattr(res, "pred_yoy")), 3)
            except Exception:
                member_preds_yoy[n] = None

    return SelectorNowcastResult(
        as_of=as_of,
        target_month=target_month,
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        picked_model=best_name,
        picked_label=_MODEL_LABELS[best_name],
        mae6_by_model={
            n: (round(maes[n], 4) if maes.get(n) is not None else None)
            for n in _MODEL_NAMES
        },
        member_preds_yoy=member_preds_yoy,
    )
