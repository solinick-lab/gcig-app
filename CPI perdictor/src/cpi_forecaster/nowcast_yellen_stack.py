"""Yellen-stack ensemble: median of clev_calibrated (Yellen 1.1) and
clev_trajectory (Yellen 1.2).

Both base models share the `clev_nowcast` quantile_rich + Cleveland-Fed
backbone, so their MoM-space errors are highly correlated. They differ
in the SHAPE of the Cleveland signal each consumes:

  - Yellen 1.1 (clev_calibrated): the level-only base model PLUS a
    Ridge bias-correction layer trained on its own in-sample residuals.
  - Yellen 1.2 (clev_trajectory): the same backbone fed extra slope /
    acceleration / lerp features extracted from the Cleveland archive.

Because trajectory sees information about the *shape* of the Cleveland
path that calibrated cannot, the two models are not perfectly
correlated even when they look at the same target. A simple median
across the two MoM-space point predictions removes idiosyncratic noise
without committing to a learned weight (which would over-fit on the
24-cut backtest window).

Stacking is performed in MoM-space at every cut, then converted to YoY
exactly the same way the base models do (log-MoM compounded onto the
last released CPI level, denominator = same-month-prior-year actual).

Bands are taken from the model whose MoM point prediction is closer to
the stacked median — that preserves a coherent (lo, mid, hi) triple
without averaging quantile widths (which would shrink them).

Public API (mirrors `nowcast.backtest_nowcast` / `run_nowcast`):
  backtest_yellen_stack_nowcast(panel, daily_frame, window_months=24,
                                as_of_day=20) -> dict
  run_yellen_stack_nowcast(as_of_day=20) -> YellenStackNowcastResult

The dict shape returned by `backtest_yellen_stack_nowcast` matches the
standard `nowcast.backtest_nowcast` response (asOfDay, windowMonths,
totalCuts, rmseMom, rmseYoy, maeYoy, hitWithin25bp, hitWithin50bp,
usedClevScrape, rows). Each row carries the per-base-model component
predictions for diagnostic purposes.

MoM clipping ([-1.5, 2.5]) and YoY band-floor (0.05) are inherited
unchanged from the base models. Every cut is wrapped in try/except.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at

# --- base models (Yellen 1.1 and Yellen 1.2) -----------------------------
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _fit_quantile_models as _fit_quantile_models_clev,
    _predict_triple as _predict_triple_clev,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)
from .nowcast_clev_calibrated import (
    _build_calibration_dataset,
    _fit_calibrator,
    _apply_calibration,
    _recent_vol,
)
from .nowcast_clev_trajectory import (
    _trajectory_features_for_month,
    _build_supervised_trajectory,
    _fit_quantile_models as _fit_quantile_models_traj,
    _predict_triple as _predict_triple_traj,
)


warnings.filterwarnings("ignore")


@dataclass
class YellenStackNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    pred_mom_calibrated: float
    pred_mom_trajectory: float


# ---------------------------------------------------------------------------
# Per-cut predictors. Each returns (mid_mom, lo_mom, hi_mom) in MoM space
# OR raises — caller catches and skips. Keeping them factored here avoids
# duplicating the inference plumbing inside the stack loop.
# ---------------------------------------------------------------------------


def _predict_calibrated_for_cut(
    panel: pd.DataFrame,
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[float, float, float] | None:
    """Replicate one cut of `backtest_clev_calibrated_nowcast` and return
    (mid_mom_calibrated, lo_mom_calibrated, hi_mom_calibrated)."""
    try:
        X, y = _build_supervised_clev(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None

        models = _fit_quantile_models_clev(X, y)
        cols = list(X.columns)

        train_y_mom = build_target(train_panel).dropna()
        F_cal, t_cal = _build_calibration_dataset(
            X, y, models, cols, train_panel, train_y_mom,
        )
        ridge = _fit_calibrator(F_cal, t_cal)

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            return None
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = (
            float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        )
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(
            np.sin(2 * np.pi * target_month_end.month / 12.0)
        )
        feats["month_cos"] = float(
            np.cos(2 * np.pi * target_month_end.month / 12.0)
        )
        try:
            feats.update(
                _clev_features_for_month(clev, target_month_end, panel)
            )
        except Exception:
            pass

        x_inf = pd.Series(feats)
        x_inf = x_inf.reindex(cols).fillna(
            X.median(numeric_only=True)
        ).fillna(0.0)

        mid_base, lo_base, hi_base = _predict_triple_clev(models, x_inf, cols)
        mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

        inf_vol = _recent_vol(train_y_mom, target_month_end)
        inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
        if not np.isfinite(inf_yml):
            inf_yml = 0.0

        mid_cal, lo_cal, hi_cal, _shift = _apply_calibration(
            ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
        )
        mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))
        return mid_cal, lo_cal, hi_cal
    except Exception:
        return None


def _predict_trajectory_for_cut(
    panel: pd.DataFrame,
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[float, float, float] | None:
    """Replicate one cut of `backtest_clev_trajectory_nowcast` and return
    (mid_mom_traj, lo_mom_traj, hi_mom_traj)."""
    try:
        X, y = _build_supervised_trajectory(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None

        models = _fit_quantile_models_traj(X, y)
        cols = list(X.columns)

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            return None
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = (
            float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        )
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
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

        mid, lo, hi = _predict_triple_traj(models, x_inf, cols)
        mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
        return mid, lo, hi
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Stacker
# ---------------------------------------------------------------------------


def _stack_two(
    a: tuple[float, float, float] | None,
    b: tuple[float, float, float] | None,
) -> tuple[float, float, float, float, float] | None:
    """Combine two (mid, lo, hi) MoM triples via simple median.

    With two base models the median equals the mean for the midpoint;
    we still call it "median" because the public spec promised median
    semantics and it generalises cleanly if a third base is added.

    For (lo, hi) we pick the band of whichever base model's mid is
    closer to the stacked midpoint (so we don't cross the bands). If
    both are equidistant we fall back to the mean of the lo/hi pairs.

    Returns (mid_stack, lo_stack, hi_stack, mid_a, mid_b) — the two
    last entries are kept for diagnostic output.
    """
    if a is None and b is None:
        return None
    if a is None:
        mid, lo, hi = b
        return mid, lo, hi, float("nan"), mid
    if b is None:
        mid, lo, hi = a
        return mid, lo, hi, mid, float("nan")

    mid_a, lo_a, hi_a = a
    mid_b, lo_b, hi_b = b
    mid_stack = float(np.median([mid_a, mid_b]))

    da = abs(mid_a - mid_stack)
    db = abs(mid_b - mid_stack)
    if da < db:
        lo_stack, hi_stack = lo_a, hi_a
    elif db < da:
        lo_stack, hi_stack = lo_b, hi_b
    else:
        lo_stack = float(np.mean([lo_a, lo_b]))
        hi_stack = float(np.mean([hi_a, hi_b]))

    # Re-clip the stacked midpoint to the same MoM bounds the bases use.
    mid_stack = float(np.clip(mid_stack, _MOM_LO_CLIP, _MOM_HI_CLIP))
    return mid_stack, lo_stack, hi_stack, mid_a, mid_b


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_yellen_stack_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the Yellen stack (median of 1.1 + 1.2).

    For each cut we:
      1. Run Yellen 1.1 (clev_calibrated) inference end-to-end.
      2. Run Yellen 1.2 (clev_trajectory) inference end-to-end.
      3. Stack the two MoM point predictions via simple median.
      4. Convert the stacked MoM to YoY using the same compounding rule
         the base models use.

    Cleveland scrape is fetched ONCE up-front; the historical archive
    in that single response is consumed by both base models (and the
    trajectory feature extractor inside Yellen 1.2).

    Each cut is wrapped in try/except. Cuts where BOTH base models
    fail are dropped. Cuts where one base fails are scored on the
    surviving base model alone.
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

            cal_triple = _predict_calibrated_for_cut(
                panel, train_panel, daily_frame, clev,
                target_month_end, as_of_day,
            )
            traj_triple = _predict_trajectory_for_cut(
                panel, train_panel, daily_frame, clev,
                target_month_end, as_of_day,
            )

            stacked = _stack_two(cal_triple, traj_triple)
            if stacked is None:
                continue
            mid_stack, lo_stack, hi_stack, mid_cal, mid_traj = stacked

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
            pred_yoy = _mom_to_yoy(
                mid_stack, last_cpi_train, target_month_end, cpi,
            )
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of_cut = _as_of_for_month(m_start, as_of_day)

            preds_mom.append(mid_stack)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of_cut.strftime("%Y-%m-%d"),
                "pred_mom": round(mid_stack, 4),
                "pred_mom_calibrated": (
                    round(mid_cal, 4) if np.isfinite(mid_cal) else None
                ),
                "pred_mom_trajectory": (
                    round(mid_traj, 4) if np.isfinite(mid_traj) else None
                ),
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


def run_yellen_stack_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> YellenStackNowcastResult:
    """Live nowcast: median of Yellen 1.1 (clev_calibrated) and Yellen
    1.2 (clev_trajectory) MoM point predictions, converted to YoY."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

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

    # ---- Yellen 1.1 (clev_calibrated) ----
    cal_triple: tuple[float, float, float] | None = None
    try:
        X_c, y_c = _build_supervised_clev(
            panel, daily_frame, clev, as_of_day=as_of_day,
        )
        models_c = _fit_quantile_models_clev(X_c, y_c)
        cols_c = list(X_c.columns)

        y_mom = build_target(panel).dropna()
        F_cal, t_cal = _build_calibration_dataset(
            X_c, y_c, models_c, cols_c, panel, y_mom,
        )
        ridge = _fit_calibrator(F_cal, t_cal)

        feats_c = rich_features_at(daily_frame, as_of)
        feats_c["cpi_mom_lag1"] = float(y_mom.iloc[-1])
        feats_c["cpi_mom_lag2"] = float(y_mom.iloc[-2])
        feats_c["cpi_yoy_lag1"] = float(
            (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
        )
        feats_c["month_sin"] = float(
            np.sin(2 * np.pi * target_month_end.month / 12.0)
        )
        feats_c["month_cos"] = float(
            np.cos(2 * np.pi * target_month_end.month / 12.0)
        )
        try:
            feats_c.update(
                _clev_features_for_month(clev, target_month_end, panel)
            )
        except Exception:
            pass

        x_inf_c = pd.Series(feats_c).reindex(cols_c).fillna(
            X_c.median(numeric_only=True)
        ).fillna(0.0)
        mid_b, lo_b, hi_b = _predict_triple_clev(models_c, x_inf_c, cols_c)
        mid_b = float(np.clip(mid_b, _MOM_LO_CLIP, _MOM_HI_CLIP))

        inf_vol = _recent_vol(y_mom, target_month_end)
        inf_yml = float(feats_c.get("clev_yoy_minus_lag", 0.0))
        if not np.isfinite(inf_yml):
            inf_yml = 0.0

        mid_cal, lo_cal, hi_cal, _shift = _apply_calibration(
            ridge, mid_b, lo_b, hi_b, inf_vol, inf_yml,
        )
        mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))
        cal_triple = (mid_cal, lo_cal, hi_cal)
    except Exception:
        cal_triple = None

    # ---- Yellen 1.2 (clev_trajectory) ----
    traj_triple: tuple[float, float, float] | None = None
    try:
        X_t, y_t = _build_supervised_trajectory(
            panel, daily_frame, clev, as_of_day=as_of_day,
        )
        models_t = _fit_quantile_models_traj(X_t, y_t)
        cols_t = list(X_t.columns)

        y_mom = build_target(panel).dropna()
        feats_t = rich_features_at(daily_frame, as_of)
        feats_t["cpi_mom_lag1"] = float(y_mom.iloc[-1])
        feats_t["cpi_mom_lag2"] = float(y_mom.iloc[-2])
        feats_t["cpi_yoy_lag1"] = float(
            (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
        )
        feats_t["month_sin"] = float(
            np.sin(2 * np.pi * target_month_end.month / 12.0)
        )
        feats_t["month_cos"] = float(
            np.cos(2 * np.pi * target_month_end.month / 12.0)
        )
        try:
            feats_t.update(
                _trajectory_features_for_month(clev, target_month_end, panel)
            )
        except Exception:
            pass

        x_inf_t = pd.Series(feats_t).reindex(cols_t).fillna(
            X_t.median(numeric_only=True)
        ).fillna(0.0)
        mid_traj, lo_traj, hi_traj = _predict_triple_traj(
            models_t, x_inf_t, cols_t,
        )
        mid_traj = float(np.clip(mid_traj, _MOM_LO_CLIP, _MOM_HI_CLIP))
        traj_triple = (mid_traj, lo_traj, hi_traj)
    except Exception:
        traj_triple = None

    stacked = _stack_two(cal_triple, traj_triple)
    if stacked is None:
        raise RuntimeError(
            "yellen_stack: both base models failed to produce a prediction"
        )
    mid_stack, lo_stack, hi_stack, mid_cal_out, mid_traj_out = stacked

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid_stack, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_stack, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_stack, last_cpi, target_month_end, cpi)

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
    return YellenStackNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_stack,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        pred_mom_calibrated=mid_cal_out,
        pred_mom_trajectory=mid_traj_out,
    )
