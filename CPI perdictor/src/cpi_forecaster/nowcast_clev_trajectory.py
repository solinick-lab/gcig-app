"""Quantile_rich + Cleveland Fed nowcast TRAJECTORY features.

Same backbone as `nowcast_clev.py` (quantile_rich features + Cleveland
nowcast snapshot), but instead of feeding only the LATEST Cleveland
nowcast value, we feed the model the SHAPE OF THE NOWCAST'S RECENT
PATH. The hypothesis: when Cleveland's daily-updated nowcast is moving
up rapidly, headline CPI is genuinely accelerating — the slope itself is
signal that the level alone misses.

Cleveland's public scrape returns a `historical[YYYY-MM]` archive that
spans ~154 months. For each PAST month we have one snapshot — the value
Cleveland published at (approximately) the as-of-day of that month.
That gives us a vintage-correct time series.

For each training cut at month T (as-of day-20 of T):
  - clev_yoy: Cleveland's nowcast at the as-of day of T
  - clev_yoy_30d_prior: Cleveland at as-of day of T-1 (30 days earlier)
  - clev_yoy_60d_prior: Cleveland at as-of day of T-2 (~60 days earlier)
  - clev_yoy_5d_lerp / clev_yoy_14d_lerp: linear interpolations between
    the T and T-1 monthly snapshots — they don't add a new cross-month
    signal but anchor the model's notion of "where the nowcast was a
    handful of days ago" using the only granularity available
  - Slopes: 30d slope = clev[T] - clev[T-1]; 60d slope = (clev[T] -
    clev[T-2]) / 2; acceleration = 30d_slope - 60d_slope
  - clev_3m_avg, clev_yoy_minus_3m_avg: smoothed level and its
    deviation from recent trend
  - clev_curr_vs_next: spread between current and next-month nowcast
    (when the live scrape covers the target month) — captures Cleveland's
    OWN forward call

Same MoM clipping ([-1.5, 2.5]), same q={0.1, 0.5, 0.9} GBR triple, same
mid/lo/hi sort to defeat quantile crossing. Each cut is wrapped in
try/except. Return shape mirrors `nowcast.backtest_nowcast`.

Public API (standard interface):
  backtest_clev_trajectory_nowcast(panel, daily_frame, window_months=24,
                                   as_of_day=20) -> dict
  run_clev_trajectory_nowcast(as_of_day=20) -> ClevTrajectoryNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel, get_cleveland_nowcast
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# FRED median CPI fallback (already in panel via EXTRA_SERIES).
_FRED_MED_CPI = "MEDCPIM158SFRBCLE"


@dataclass
class ClevTrajectoryNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Cleveland scrape helpers
# ---------------------------------------------------------------------------


def _safe_get_clev() -> dict:
    """Fetch Cleveland nowcast via API. Always returns a dict (never raises)."""
    try:
        return get_cleveland_nowcast()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "headline": {},
            "core": {},
            "historical": {},
            "error": str(exc),
        }


def _hist_entry(clev: dict, key: str) -> dict | None:
    """Pull the historical[YYYY-MM] entry, or None if missing/malformed."""
    if not isinstance(clev, dict) or not clev.get("ok"):
        return None
    hist = clev.get("historical") or {}
    if not isinstance(hist, dict):
        return None
    entry = hist.get(key)
    if not isinstance(entry, dict):
        return None
    return entry


def _hist_yoy(clev: dict, key: str) -> float:
    """Cleveland headline YoY at historical[key] — np.nan if missing."""
    entry = _hist_entry(clev, key)
    if entry is None:
        return float("nan")
    v = entry.get("yoy")
    if isinstance(v, (int, float)) and np.isfinite(v):
        return float(v)
    return float("nan")


def _hist_mom(clev: dict, key: str) -> float:
    entry = _hist_entry(clev, key)
    if entry is None:
        return float("nan")
    v = entry.get("mom")
    if isinstance(v, (int, float)) and np.isfinite(v):
        return float(v)
    return float("nan")


def _hist_core_yoy(clev: dict, key: str) -> float:
    entry = _hist_entry(clev, key)
    if entry is None:
        return float("nan")
    v = entry.get("coreYoy")
    if isinstance(v, (int, float)) and np.isfinite(v):
        return float(v)
    return float("nan")


# ---------------------------------------------------------------------------
# Trajectory feature builder
# ---------------------------------------------------------------------------


def _trajectory_features_for_month(
    clev: dict,
    target_month_end: pd.Timestamp,
    panel: pd.DataFrame,
) -> dict[str, float]:
    """Build Cleveland-trajectory features for one target month.

    Vintage discipline: at as-of day-20 of month T we may legitimately
    consult Cleveland's archive entries up to AND INCLUDING month T
    (because the historical[T] entry is taken at ~day-20 of T). We may
    NOT consult historical[T+1] (the future).

    Feature names returned (all floats; np.nan if not available):
      clev_yoy                      — Cleveland headline YoY at as-of day of T
      clev_mom                      — same, MoM
      clev_core_yoy                 — core YoY
      clev_yoy_30d_prior            — historical[T-1].yoy  (vintage-correct prior month)
      clev_yoy_60d_prior            — historical[T-2].yoy
      clev_yoy_90d_prior            — historical[T-3].yoy
      clev_yoy_5d_lerp              — lerp(T-1, T, 25/30) — synthetic 5d-ago
      clev_yoy_14d_lerp             — lerp(T-1, T, 16/30) — synthetic 14d-ago
      clev_slope_30d                — clev[T] - clev[T-1]
      clev_slope_60d                — (clev[T] - clev[T-2]) / 2
      clev_slope_90d                — (clev[T] - clev[T-3]) / 3
      clev_slope_5d                 — implied 5d slope (lerp-based, monthly-rate)
      clev_slope_14d                — implied 14d slope
      clev_accel                    — slope_30d - slope_60d (acceleration)
      clev_3m_avg                   — mean of clev[T], clev[T-1], clev[T-2]
      clev_yoy_minus_3m_avg         — clev[T] - clev_3m_avg
      clev_curr_vs_next             — live next-month nowcast minus current
      clev_used_scrape              — 1 if any of the above came from scrape

    On total scrape failure all archive lookups are NaN; we still return
    the feature dict with np.nan values (median-imputed at fit time) and
    include a FRED-median proxy for `clev_yoy` so the model isn't
    starved.
    """
    feats: dict[str, float] = {
        "clev_yoy": np.nan,
        "clev_mom": np.nan,
        "clev_core_yoy": np.nan,
        "clev_yoy_30d_prior": np.nan,
        "clev_yoy_60d_prior": np.nan,
        "clev_yoy_90d_prior": np.nan,
        "clev_yoy_5d_lerp": np.nan,
        "clev_yoy_14d_lerp": np.nan,
        "clev_slope_30d": np.nan,
        "clev_slope_60d": np.nan,
        "clev_slope_90d": np.nan,
        "clev_slope_5d": np.nan,
        "clev_slope_14d": np.nan,
        "clev_accel": np.nan,
        "clev_3m_avg": np.nan,
        "clev_yoy_minus_3m_avg": np.nan,
        "clev_curr_vs_next": np.nan,
        "clev_yoy_minus_lag": np.nan,
        "clev_used_scrape": 0.0,
    }

    target_key = target_month_end.strftime("%Y-%m")
    prior_1_key = (target_month_end + pd.offsets.MonthBegin(-1)
                   + pd.offsets.MonthEnd(-1)).strftime("%Y-%m")
    # Robust month-key arithmetic via pd.Timestamp on month start.
    t_start = target_month_end + pd.offsets.MonthBegin(-1)
    prior_1_key = (t_start + pd.offsets.MonthBegin(-1)).strftime("%Y-%m")
    prior_2_key = (t_start + pd.offsets.MonthBegin(-2)).strftime("%Y-%m")
    prior_3_key = (t_start + pd.offsets.MonthBegin(-3)).strftime("%Y-%m")
    next_key = (t_start + pd.offsets.MonthBegin(1)).strftime("%Y-%m")

    used_scrape = False

    # Pull current-vintage value (preferred: historical[T]).
    yoy_t = _hist_yoy(clev, target_key)
    mom_t = _hist_mom(clev, target_key)
    core_t = _hist_core_yoy(clev, target_key)
    if np.isfinite(yoy_t):
        feats["clev_yoy"] = yoy_t
        used_scrape = True
    if np.isfinite(mom_t):
        feats["clev_mom"] = mom_t
        used_scrape = True
    if np.isfinite(core_t):
        feats["clev_core_yoy"] = core_t

    # If the historical archive doesn't cover month T (typical for the
    # CURRENT live cut), fall back to the live currentMonth/nextMonth
    # entry that matches target_key.
    if not np.isfinite(feats["clev_yoy"]) and isinstance(clev, dict) and clev.get("ok"):
        for slot in ("currentMonth", "nextMonth"):
            head = clev.get("headline", {}).get(slot) or {}
            core = clev.get("core", {}).get(slot) or {}
            if head.get("month") == target_key:
                if isinstance(head.get("yoy"), (int, float)):
                    feats["clev_yoy"] = float(head["yoy"])
                    used_scrape = True
                if isinstance(head.get("mom"), (int, float)):
                    feats["clev_mom"] = float(head["mom"])
                    used_scrape = True
                if isinstance(core.get("yoy"), (int, float)):
                    feats["clev_core_yoy"] = float(core["yoy"])
                break

    # Vintage-correct prior-month archive lookups.
    yoy_p1 = _hist_yoy(clev, prior_1_key)
    yoy_p2 = _hist_yoy(clev, prior_2_key)
    yoy_p3 = _hist_yoy(clev, prior_3_key)
    if np.isfinite(yoy_p1):
        feats["clev_yoy_30d_prior"] = yoy_p1
        used_scrape = True
    if np.isfinite(yoy_p2):
        feats["clev_yoy_60d_prior"] = yoy_p2
    if np.isfinite(yoy_p3):
        feats["clev_yoy_90d_prior"] = yoy_p3

    # Slopes (per-month rate). Acceleration = how fast the slope is
    # itself moving — signal of true momentum shift.
    if np.isfinite(feats["clev_yoy"]) and np.isfinite(feats["clev_yoy_30d_prior"]):
        feats["clev_slope_30d"] = feats["clev_yoy"] - feats["clev_yoy_30d_prior"]
    if np.isfinite(feats["clev_yoy"]) and np.isfinite(feats["clev_yoy_60d_prior"]):
        feats["clev_slope_60d"] = (feats["clev_yoy"] - feats["clev_yoy_60d_prior"]) / 2.0
    if np.isfinite(feats["clev_yoy"]) and np.isfinite(feats["clev_yoy_90d_prior"]):
        feats["clev_slope_90d"] = (feats["clev_yoy"] - feats["clev_yoy_90d_prior"]) / 3.0
    if np.isfinite(feats["clev_slope_30d"]) and np.isfinite(feats["clev_slope_60d"]):
        feats["clev_accel"] = feats["clev_slope_30d"] - feats["clev_slope_60d"]

    # 5d / 14d "lerp" features — anchor the model on intra-month
    # interpolated levels. Even though the daily resolution isn't real,
    # the SCALED slope (per-day rate) gives the model an explicit
    # short-window momentum knob it can weight differently from the
    # 30d/60d slopes.
    if np.isfinite(feats["clev_yoy"]) and np.isfinite(feats["clev_yoy_30d_prior"]):
        delta_30d = feats["clev_yoy"] - feats["clev_yoy_30d_prior"]
        # 25/30 of the way from prior to current = the value 5 days ago
        feats["clev_yoy_5d_lerp"] = (
            feats["clev_yoy_30d_prior"] + (25.0 / 30.0) * delta_30d
        )
        feats["clev_yoy_14d_lerp"] = (
            feats["clev_yoy_30d_prior"] + (16.0 / 30.0) * delta_30d
        )
        # Per-day slope expressed as a monthly-rate equivalent.
        feats["clev_slope_5d"] = (
            feats["clev_yoy"] - feats["clev_yoy_5d_lerp"]
        ) * (30.0 / 5.0)
        feats["clev_slope_14d"] = (
            feats["clev_yoy"] - feats["clev_yoy_14d_lerp"]
        ) * (30.0 / 14.0)

    # 3-month rolling average and deviation.
    triple = [
        v for v in (feats["clev_yoy"], feats["clev_yoy_30d_prior"],
                    feats["clev_yoy_60d_prior"])
        if np.isfinite(v)
    ]
    if len(triple) >= 2:
        feats["clev_3m_avg"] = float(np.mean(triple))
        if np.isfinite(feats["clev_yoy"]):
            feats["clev_yoy_minus_3m_avg"] = (
                feats["clev_yoy"] - feats["clev_3m_avg"]
            )

    # Live next-month forward call (only meaningful when scrape is fresh
    # AND the live currentMonth slot matches target_key — otherwise we
    # can't safely use a live "next" for vintage-correct backtesting).
    try:
        head_curr = (clev.get("headline", {}) or {}).get("currentMonth") or {}
        head_next = (clev.get("headline", {}) or {}).get("nextMonth") or {}
        if (
            head_curr.get("month") == target_key
            and isinstance(head_curr.get("yoy"), (int, float))
            and isinstance(head_next.get("yoy"), (int, float))
        ):
            feats["clev_curr_vs_next"] = (
                float(head_next["yoy"]) - float(head_curr["yoy"])
            )
    except Exception:
        pass

    # Also allow a vintage-correct curr_vs_next from archive: clev[T+1]
    # is FUTURE relative to T's as-of, so we can't use it. But clev[T] -
    # clev[T-1] over the available archive doubles as that signal and is
    # already captured in clev_slope_30d.

    # FRED-median fallback for clev_yoy if scrape gave us nothing at
    # all. Use the same construction as nowcast_clev.py so behaviour
    # under scrape outage stays consistent.
    if not np.isfinite(feats["clev_yoy"]):
        try:
            if _FRED_MED_CPI in panel.columns:
                s = panel[_FRED_MED_CPI].dropna()
                last_released = (
                    target_month_end + pd.offsets.MonthBegin(-1)
                    - pd.Timedelta(days=1)
                ) + pd.offsets.MonthEnd(0)
                prior = s.loc[s.index <= last_released]
                if len(prior) >= 13:
                    med_yoy = float(
                        (prior.iloc[-1] / prior.iloc[-13] - 1.0) * 100.0
                    )
                    cpi = panel[TARGET.fred_id].dropna()
                    cpi_prior = cpi.loc[cpi.index <= last_released]
                    if len(cpi_prior) >= 13:
                        head_yoy = float(
                            (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0)
                            * 100.0
                        )
                        wedge = head_yoy - med_yoy
                    else:
                        wedge = 0.0
                    feats["clev_yoy"] = med_yoy + wedge
                    feats["clev_core_yoy"] = med_yoy
                    if prior.iloc[-2] != 0:
                        feats["clev_mom"] = float(
                            (prior.iloc[-1] / prior.iloc[-2] - 1.0) * 100.0
                        )
        except Exception:
            pass

    # Momentum vs last released BLS (kept for compatibility with
    # nowcast_clev features — same definition).
    try:
        cpi = panel[TARGET.fred_id].dropna()
        last_released = (
            target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
        ) + pd.offsets.MonthEnd(0)
        cpi_prior = cpi.loc[cpi.index <= last_released]
        if len(cpi_prior) >= 13 and np.isfinite(feats["clev_yoy"]):
            lag_yoy = float(
                (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0
            )
            feats["clev_yoy_minus_lag"] = feats["clev_yoy"] - lag_yoy
    except Exception:
        pass

    if used_scrape:
        feats["clev_used_scrape"] = 1.0

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_trajectory(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich features + Cleveland trajectory features per month."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible_months = y_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        try:
            feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
        try:
            feats["cpi_mom_lag2"] = (
                float(y_mom.loc[:month_end].iloc[-3])
                if len(y_mom.loc[:month_end]) >= 3 else np.nan
            )
        except Exception:
            feats["cpi_mom_lag2"] = np.nan
        try:
            cpi_until = cpi.loc[:month_end]
            if len(cpi_until) >= 14:
                feats["cpi_yoy_lag1"] = float(
                    (cpi_until.iloc[-2] / cpi_until.iloc[-14] - 1.0) * 100.0
                )
            else:
                feats["cpi_yoy_lag1"] = np.nan
        except Exception:
            feats["cpi_yoy_lag1"] = np.nan
        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))

        # Cleveland trajectory features for THIS training row.
        try:
            feats.update(
                _trajectory_features_for_month(clev, month_end, panel)
            )
        except Exception:
            pass

        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------------
# Fit / predict helpers
# ---------------------------------------------------------------------------


def _fit_quantile_models(
    X: pd.DataFrame, y: pd.Series,
) -> dict[float, GradientBoostingRegressor]:
    """Fit q={0.1, 0.5, 0.9} GBR. Each independently."""
    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(X.values, y.values)
    return models


def _predict_triple(
    models: dict[float, GradientBoostingRegressor],
    x_inf: pd.Series,
    cols: list[str],
) -> tuple[float, float, float]:
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    preds = sorted(float(models[q].predict(aligned)[0]) for q in _QUANTILES)
    lo, mid, hi = preds
    return mid, lo, hi


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_clev_trajectory_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using quantile_rich + Cleveland trajectory features.

    Calls the Cleveland scrape ONCE up-front; the historical archive
    inside that single response covers all cuts.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            X, y = _build_supervised_trajectory(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # Inference features for this cut.
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = (
                float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            )
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0)
                * 100.0
            )
            feats["month_sin"] = float(
                np.sin(2 * np.pi * target_month_end.month / 12.0)
            )
            feats["month_cos"] = float(
                np.cos(2 * np.pi * target_month_end.month / 12.0)
            )
            try:
                feats.update(
                    _trajectory_features_for_month(
                        clev, target_month_end, panel,
                    )
                )
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(
                X.median(numeric_only=True)
            ).fillna(0.0)

            mid, lo, hi = _predict_triple(models, x_inf, cols)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
            pred_yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
            })
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts"}

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
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_clev_trajectory_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ClevTrajectoryNowcastResult:
    """Live nowcast using fresh Cleveland scrape + trajectory features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_trajectory(
        panel, daily_frame, clev, as_of_day=as_of_day,
    )
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(
        np.sin(2 * np.pi * target_month_end.month / 12.0)
    )
    feats["month_cos"] = float(
        np.cos(2 * np.pi * target_month_end.month / 12.0)
    )
    try:
        feats.update(
            _trajectory_features_for_month(clev, target_month_end, panel)
        )
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(
        X.median(numeric_only=True)
    ).fillna(0.0)
    mid, lo, hi = _predict_triple(models, x_inf, cols)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(
            s.loc[(s.index >= target_month_start) & (s.index <= as_of)]
        ) > 0
    )
    return ClevTrajectoryNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
