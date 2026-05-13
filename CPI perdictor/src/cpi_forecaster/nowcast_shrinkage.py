"""Hit-rate-optimized nowcaster via shrinkage to recent CPI YoY.

Hypothesis: Yellen 1.1 (clev_calibrated) misses on regime-shift months
(e.g. Jan 2025 by 0.74pp) because the base model + linear calibrator can
overshoot when rolling onto a disinflation/re-acceleration regime. A
SHRUNKEN prediction stays closer to the trailing CPI YoY level, reducing
tail misses at the (mild) cost of higher RMSE on stable months — which
is the right trade for the hit25 metric.

Math:
    final_pred_yoy = (1 - alpha) * clev_calibrated_pred + alpha * recent_anchor
where `recent_anchor = mean(YoY[t-1], YoY[t-2], YoY[t-3])` — the trailing
3-month CPI YoY mean as of inference time.

Alpha is tuned per cut by inner CV on the LAST 6 cuts of the training
window: pick the alpha (in a small grid) that maximizes hit25 on those
6 inner cuts. Ties are broken by lowest MAE (then defaults to 0.35).

Public API:
  backtest_shrinkage_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_shrinkage_nowcast(as_of_day=20) -> ShrinkageNowcastResult

Each cut wrapped in try/except. MoM clipped via base model's clip; YoY
shrinkage applied AFTER conversion to YoY (the spec is explicitly in
YoY space).
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
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _fit_quantile_models,
    _predict_triple,
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


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

# Grid for alpha (shrinkage weight on recent_anchor).
_ALPHA_GRID: tuple[float, ...] = (0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50)
_DEFAULT_ALPHA = 0.35
_INNER_CV_CUTS = 6
_HIT25_BP = 0.25
_ANCHOR_WINDOW = 3  # trailing months of YoY for the anchor


@dataclass
class ShrinkageNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    alpha_used: float
    recent_anchor_yoy: float
    base_pred_yoy: float


# ---------------------------------------------------------------------------
# Anchor + shrinkage helpers
# ---------------------------------------------------------------------------


def _yoy_series(cpi: pd.Series) -> pd.Series:
    """Compute the YoY % series from a CPI level series (monthly)."""
    if len(cpi) < 13:
        return pd.Series(dtype=float)
    yoy = (cpi / cpi.shift(12) - 1.0) * 100.0
    return yoy.dropna()


def _recent_anchor_yoy(cpi: pd.Series, target_month_end: pd.Timestamp) -> float:
    """Mean YoY over the trailing _ANCHOR_WINDOW months strictly BEFORE target_month_end.

    The anchor uses ALREADY-RELEASED CPI YoY values: months t-1, t-2, t-3
    relative to the target. If we don't have enough history, we fall back
    to whatever is available (down to 1 month). NaN if no history.
    """
    try:
        cpi_prior = cpi.loc[cpi.index < target_month_end].dropna()
        yoy = _yoy_series(cpi_prior)
        if len(yoy) == 0:
            return float("nan")
        tail = yoy.iloc[-_ANCHOR_WINDOW:]
        if len(tail) == 0:
            return float("nan")
        return float(np.mean(tail.values))
    except Exception:
        return float("nan")


def _shrink(
    base_pred_yoy: float,
    recent_anchor_yoy: float,
    alpha: float,
) -> float:
    """final = (1 - alpha) * base + alpha * anchor."""
    if not np.isfinite(recent_anchor_yoy):
        return float(base_pred_yoy)
    a = float(np.clip(alpha, 0.0, 1.0))
    return float((1.0 - a) * base_pred_yoy + a * recent_anchor_yoy)


# ---------------------------------------------------------------------------
# Single-cut clev_calibrated forecast (used for both inner CV and main loop)
# ---------------------------------------------------------------------------


def _clev_calibrated_forecast_for_cut(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[float, float, float, float, float] | None:
    """Run the clev_calibrated pipeline for a single cut.

    Returns (mid_yoy, lo_yoy, hi_yoy, mid_mom, recent_anchor_yoy) or None
    on failure. Uses panel data strictly < target_month_end.
    """
    try:
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            return None

        X, y = _build_supervised_clev(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None

        models = _fit_quantile_models(X, y)
        cols = list(X.columns)

        # Calibration on in-sample residuals
        train_y_mom = build_target(train_panel).dropna()
        F_cal, t_cal = _build_calibration_dataset(
            X, y, models, cols, train_panel, train_y_mom
        )
        ridge = _fit_calibrator(F_cal, t_cal)

        # Inference features
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
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        try:
            feats.update(_clev_features_for_month(clev, target_month_end, panel))
        except Exception:
            pass

        x_inf = pd.Series(feats).reindex(cols)
        x_inf = x_inf.fillna(X.median(numeric_only=True)).fillna(0.0)

        mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
        mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

        inf_vol = _recent_vol(train_y_mom, target_month_end)
        inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
        if not np.isfinite(inf_yml):
            inf_yml = 0.0

        mid_cal, lo_cal, hi_cal, _shift = _apply_calibration(
            ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
        )
        mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

        # Convert to YoY using TRAINING-window CPI as the anchor month
        cpi = panel[TARGET.fred_id].dropna()
        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        mid_yoy = _mom_to_yoy(mid_cal, last_cpi_train, target_month_end, cpi)
        lo_yoy = _mom_to_yoy(lo_cal, last_cpi_train, target_month_end, cpi)
        hi_yoy = _mom_to_yoy(hi_cal, last_cpi_train, target_month_end, cpi)

        anchor = _recent_anchor_yoy(cpi, target_month_end)

        return mid_yoy, lo_yoy, hi_yoy, mid_cal, anchor
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Inner CV: tune alpha on the trailing _INNER_CV_CUTS of training data
# ---------------------------------------------------------------------------


def _tune_alpha_inner_cv(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[float, dict]:
    """Pick alpha that maximizes hit25 on the last _INNER_CV_CUTS of training.

    For each candidate alpha, we replay the clev_calibrated forecast for
    the last 6 already-released months STRICTLY BEFORE target_month_end,
    apply shrinkage, and score hit25. Tie-break: lower MAE; then default.

    Returns (alpha_star, debug_info).
    """
    cpi = panel[TARGET.fred_id].dropna()
    train_y_mom = build_target(panel.loc[panel.index < target_month_end]).dropna()
    if len(train_y_mom) < (_INNER_CV_CUTS + 12):
        return _DEFAULT_ALPHA, {"reason": "too few training cuts", "n": int(len(train_y_mom))}

    inner_targets = list(train_y_mom.index[-_INNER_CV_CUTS:])
    base_yoy_preds: list[float] = []
    anchors: list[float] = []
    actual_yoys: list[float] = []

    for tm in inner_targets:
        out = _clev_calibrated_forecast_for_cut(
            panel, daily_frame, clev, tm, as_of_day=as_of_day,
        )
        if out is None:
            continue
        mid_yoy, _lo, _hi, _mom, anchor = out
        try:
            actual_cpi = float(cpi.loc[tm])
            denom_idx = tm - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0
        except Exception:
            continue
        base_yoy_preds.append(mid_yoy)
        anchors.append(anchor)
        actual_yoys.append(actual_yoy)

    if len(base_yoy_preds) < 3:
        return _DEFAULT_ALPHA, {"reason": "too few inner cuts succeeded", "n": len(base_yoy_preds)}

    base = np.asarray(base_yoy_preds, dtype=float)
    anch = np.asarray(anchors, dtype=float)
    act = np.asarray(actual_yoys, dtype=float)

    best_alpha = _DEFAULT_ALPHA
    best_hits = -1
    best_mae = float("inf")
    scores: list[dict] = []
    for a in _ALPHA_GRID:
        # If anchor is NaN for some rows, fall back to base for those
        anch_safe = np.where(np.isfinite(anch), anch, base)
        shrunk = (1.0 - a) * base + a * anch_safe
        err = np.abs(shrunk - act)
        hits = int(np.sum(err <= _HIT25_BP))
        mae = float(np.mean(err))
        scores.append({"alpha": a, "hits": hits, "mae": round(mae, 4)})
        if (hits > best_hits) or (hits == best_hits and mae < best_mae):
            best_hits = hits
            best_mae = mae
            best_alpha = float(a)

    return best_alpha, {"scores": scores, "n": len(base_yoy_preds)}


# ---------------------------------------------------------------------------
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_shrinkage_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of clev_calibrated + recent-CPI shrinkage."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            # 1) Tune alpha by inner CV on the last 6 training cuts
            alpha_star, _alpha_dbg = _tune_alpha_inner_cv(
                train_panel, daily_frame, clev,
                target_month_end=target_month_end,
                as_of_day=as_of_day,
            )

            # 2) Run base forecast on this cut
            out = _clev_calibrated_forecast_for_cut(
                panel, daily_frame, clev, target_month_end, as_of_day=as_of_day,
            )
            if out is None:
                continue
            mid_yoy_base, lo_yoy_base, hi_yoy_base, mid_mom, anchor = out

            # 3) Shrink toward recent CPI YoY anchor
            final_pred_yoy = _shrink(mid_yoy_base, anchor, alpha_star)
            shift = final_pred_yoy - mid_yoy_base
            final_lo_yoy = lo_yoy_base + shift
            final_hi_yoy = hi_yoy_base + shift

            # 4) Score
            actual_mom = float(y_mom.iloc[ci])
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_yoy.append(final_pred_yoy)
            actuals_yoy.append(actual_yoy)
            preds_mom.append(mid_mom)
            actuals_mom.append(actual_mom)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": _as_of_for_month(
                    target_month_end + pd.offsets.MonthBegin(-1), as_of_day
                ).strftime("%Y-%m-%d"),
                "alpha": round(alpha_star, 3),
                "recent_anchor_yoy": round(anchor, 3) if np.isfinite(anchor) else None,
                "base_pred_yoy": round(mid_yoy_base, 3),
                "pred_yoy": round(final_pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(final_pred_yoy - actual_yoy, 3),
                "pred_mom": round(mid_mom, 4),
                "actual_mom": round(actual_mom, 4),
            })
        except Exception:
            continue

    if not preds_yoy:
        return {"error": "no successful cuts"}

    py = np.array(preds_yoy)
    ay = np.array(actuals_yoy)
    pm = np.array(preds_mom)
    am = np.array(actuals_mom)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_yoy),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Public API: live nowcast
# ---------------------------------------------------------------------------


def run_shrinkage_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ShrinkageNowcastResult:
    """Live nowcast: clev_calibrated base + recent-CPI shrinkage."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # 1) Tune alpha on inner CV using the most-recent 6 already-released months
    alpha_star, _alpha_dbg = _tune_alpha_inner_cv(
        panel, daily_frame, clev,
        target_month_end=target_month_end,
        as_of_day=as_of_day,
    )

    # 2) Run full clev_calibrated base forecast
    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    y_mom = build_target(panel).dropna()
    F_cal, t_cal = _build_calibration_dataset(X, y, models, cols, panel, y_mom)
    ridge = _fit_calibrator(F_cal, t_cal)

    feats = rich_features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2]) if len(y_mom) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
    mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
    mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

    inf_vol = _recent_vol(y_mom, target_month_end)
    inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
    if not np.isfinite(inf_yml):
        inf_yml = 0.0

    mid_cal, lo_cal, hi_cal, _shift = _apply_calibration(
        ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    base_pred_yoy = _mom_to_yoy(mid_cal, last_cpi, target_month_end, cpi)
    base_lo_yoy = _mom_to_yoy(lo_cal, last_cpi, target_month_end, cpi)
    base_hi_yoy = _mom_to_yoy(hi_cal, last_cpi, target_month_end, cpi)

    # 3) Shrink to recent CPI anchor
    anchor = _recent_anchor_yoy(cpi, target_month_end)
    final_pred_yoy = _shrink(base_pred_yoy, anchor, alpha_star)
    shift_yoy = final_pred_yoy - base_pred_yoy
    final_lo_yoy = base_lo_yoy + shift_yoy
    final_hi_yoy = base_hi_yoy + shift_yoy

    if (final_hi_yoy - final_pred_yoy) < _RESID_FLOOR:
        final_hi_yoy = final_pred_yoy + _RESID_FLOOR
    if (final_pred_yoy - final_lo_yoy) < _RESID_FLOOR:
        final_lo_yoy = final_pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return ShrinkageNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,
        pred_yoy=final_pred_yoy,
        lo80_yoy=final_lo_yoy,
        hi80_yoy=final_hi_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        alpha_used=float(alpha_star),
        recent_anchor_yoy=float(anchor) if np.isfinite(anchor) else float("nan"),
        base_pred_yoy=float(base_pred_yoy),
    )
