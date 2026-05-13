"""Regime-aware nowcaster: anomaly detection + conservative anchor fallback.

Hypothesis: Yellen 1.1 (clev_calibrated) is excellent on average but can
miss badly on "unusual" months where the model's prediction diverges
sharply from the recent inflation trend. On those rare cuts, blending
toward a conservative anchor (trailing 6-month YoY median) reduces tail
error and lifts hit-25.

Approach:
  1. Run Yellen 1.1 internally for every cut (training + inference).
  2. Compute recent_anchor = median of the last 6 monthly YoY prints
     strictly before the target month.
  3. anomaly_score = |yellen_pred_yoy - recent_anchor|  (in pp).
  4. If anomaly_score < threshold: trust the model (most cuts).
  5. If anomaly_score >= threshold: blend
        final = w * yellen_pred + (1 - w) * recent_anchor
     where (threshold, w) are tuned on an inner CV.
  6. Inner CV: walk-forward over training cuts, picking
     threshold ∈ {0.30, 0.40, 0.50} and blend weight w ∈ {0.4, 0.5, 0.6}
     to maximize hit-25.

Public API mirrors nowcast_clev_calibrated:
  backtest_anomaly_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_anomaly_nowcast(as_of_day=20) -> AnomalyNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
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

_ANCHOR_WINDOW = 6                                  # months for trailing YoY median
_THRESHOLD_GRID = (0.30, 0.40, 0.50)                # anomaly thresholds (pp)
_BLEND_GRID = (0.40, 0.50, 0.60)                    # weight on yellen_pred when anomalous
_DEFAULT_THRESHOLD = 0.40
_DEFAULT_BLEND = 0.50
_INNER_CV_MIN_ROWS = 12                             # min rows to attempt CV tuning


@dataclass
class AnomalyNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    yellen_pred_yoy: float
    recent_anchor_yoy: float
    anomaly_score: float
    threshold_used: float
    blend_weight: float
    triggered_fallback: bool


# ---------------------------------------------------------------------------
# Anchor & helpers
# ---------------------------------------------------------------------------


def _recent_yoy_anchor(
    cpi: pd.Series, target_month_end: pd.Timestamp, window: int = _ANCHOR_WINDOW
) -> float:
    """Trailing `window`-month YoY median strictly before target_month_end.

    For each of the last `window` released months, compute YoY from the
    panel and take the median. Robust to outliers vs. mean.
    """
    try:
        prior = cpi.loc[cpi.index < target_month_end]
        if len(prior) < 13:
            return float("nan")
        tail = prior.iloc[-window:]
        yoy_vals: list[float] = []
        for idx in tail.index:
            try:
                denom_idx = idx - pd.DateOffset(years=1)
                denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
                if denom_idx in cpi.index:
                    denom = float(cpi.loc[denom_idx])
                else:
                    denom = float(cpi.asof(denom_idx))
                if not np.isfinite(denom) or denom <= 0:
                    continue
                yoy_vals.append((float(cpi.loc[idx]) / denom - 1.0) * 100.0)
            except Exception:
                continue
        if not yoy_vals:
            return float("nan")
        return float(np.median(yoy_vals))
    except Exception:
        return float("nan")


def _apply_regime(
    yellen_yoy: float,
    anchor_yoy: float,
    threshold: float,
    blend_w: float,
) -> tuple[float, float, bool]:
    """Apply the anomaly-gate decision rule. Returns (final_yoy, anomaly_score, triggered)."""
    if not (np.isfinite(yellen_yoy) and np.isfinite(anchor_yoy)):
        return yellen_yoy, 0.0, False
    score = abs(yellen_yoy - anchor_yoy)
    if score < threshold:
        return yellen_yoy, score, False
    blended = blend_w * yellen_yoy + (1.0 - blend_w) * anchor_yoy
    return blended, score, True


# ---------------------------------------------------------------------------
# Inner-CV tuner
# ---------------------------------------------------------------------------


def _tune_threshold_blend(
    pred_yoys: list[float],
    anchor_yoys: list[float],
    actual_yoys: list[float],
) -> tuple[float, float]:
    """Pick (threshold, blend_w) from grids that maximize hit-25 over the
    in-sample (train) cuts. Tie-breaker: lower MAE.

    pred_yoys / anchor_yoys / actual_yoys are aligned arrays of in-sample
    Yellen 1.1 predictions, anchors, and actuals over the training window.
    """
    if (
        len(pred_yoys) < _INNER_CV_MIN_ROWS
        or len(pred_yoys) != len(anchor_yoys)
        or len(pred_yoys) != len(actual_yoys)
    ):
        return _DEFAULT_THRESHOLD, _DEFAULT_BLEND

    pp = np.asarray(pred_yoys, dtype=float)
    aa = np.asarray(anchor_yoys, dtype=float)
    yy = np.asarray(actual_yoys, dtype=float)
    mask = np.isfinite(pp) & np.isfinite(aa) & np.isfinite(yy)
    if mask.sum() < _INNER_CV_MIN_ROWS:
        return _DEFAULT_THRESHOLD, _DEFAULT_BLEND
    pp = pp[mask]; aa = aa[mask]; yy = yy[mask]

    best = (_DEFAULT_THRESHOLD, _DEFAULT_BLEND)
    best_hit = -1.0
    best_mae = float("inf")
    for thr in _THRESHOLD_GRID:
        for w in _BLEND_GRID:
            scores = np.abs(pp - aa)
            anomalous = scores >= thr
            finals = np.where(anomalous, w * pp + (1.0 - w) * aa, pp)
            err = np.abs(finals - yy)
            hit25 = float((err <= 0.25).mean())
            mae = float(err.mean())
            if (hit25 > best_hit) or (hit25 == best_hit and mae < best_mae):
                best_hit = hit25
                best_mae = mae
                best = (thr, w)
    return best


# ---------------------------------------------------------------------------
# Internal: produce a Yellen 1.1 (clev_calibrated) YoY prediction for a cut
# ---------------------------------------------------------------------------


def _yellen_predict_for_cut(
    panel: pd.DataFrame,
    daily_frame: dict,
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> dict | None:
    """Run Yellen 1.1 on data <= target_month_end (excluded). Returns dict
    with yellen_yoy, mid_cal_mom, lo_cal_mom, hi_cal_mom, last_cpi_train,
    as_of, train_y_mom — or None on failure.
    """
    try:
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            return None
        X, y = _build_supervised_clev(train_panel, daily_frame, clev, as_of_day=as_of_day)
        if len(X) < 24:
            return None
        models = _fit_quantile_models(X, y)
        cols = list(X.columns)

        # Calibration (Yellen 1.1's signature step)
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
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        cpi_train = train_panel[TARGET.fred_id].dropna()
        feats["cpi_yoy_lag1"] = float(
            (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        try:
            feats.update(_clev_features_for_month(clev, target_month_end, panel))
        except Exception:
            pass

        x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
        mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
        mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

        inf_vol = _recent_vol(train_y_mom, target_month_end)
        inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
        if not np.isfinite(inf_yml):
            inf_yml = 0.0
        mid_cal, lo_cal, hi_cal, _bs = _apply_calibration(
            ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
        )
        mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

        last_cpi_train = float(cpi_train.iloc[-1])
        cpi_full = panel[TARGET.fred_id].dropna()
        yellen_yoy = _mom_to_yoy(mid_cal, last_cpi_train, target_month_end, cpi_full)

        return {
            "yellen_yoy": yellen_yoy,
            "mid_cal_mom": mid_cal,
            "lo_cal_mom": lo_cal,
            "hi_cal_mom": hi_cal,
            "last_cpi_train": last_cpi_train,
            "as_of": as_of,
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_anomaly_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of Yellen 1.1 with anomaly-anchor regime gate.

    For each held-out cut we tune (threshold, blend_w) on an INNER CV
    using only training-window cuts, then apply the chosen rule to the
    Yellen 1.1 live prediction for that target month.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    # ---- Pass 1: precompute Yellen-1.1 yoy + anchor + actual for ALL cuts in
    # the available history, so each held-out cut can do an inner CV using
    # only PRIOR cuts (walk-forward, no leakage).
    inner_cuts_global: list[dict] = []
    # Build inner-CV history: walk-forward up to (but not into) the
    # backtest window. We use the run of cuts BEFORE the first backtest
    # cut as "warm-up history" for tuning.
    warmup_start = max(13, len(y_mom) - window_months - 24)  # up to 24 months of pre-window history
    for ci in range(warmup_start, len(y_mom)):
        try:
            tme = y_mom.index[ci]
            res = _yellen_predict_for_cut(panel, daily_frame, clev, tme, as_of_day)
            if res is None:
                continue
            anchor = _recent_yoy_anchor(cpi, tme)
            if not np.isfinite(anchor):
                continue
            actual_cpi = float(cpi.loc[tme])
            denom_idx = tme - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0
            inner_cuts_global.append({
                "ci": ci,
                "tme": tme,
                "yellen_yoy": res["yellen_yoy"],
                "anchor_yoy": anchor,
                "actual_yoy": actual_yoy,
                "mid_cal_mom": res["mid_cal_mom"],
                "lo_cal_mom": res["lo_cal_mom"],
                "hi_cal_mom": res["hi_cal_mom"],
                "last_cpi_train": res["last_cpi_train"],
                "as_of": res["as_of"],
            })
        except Exception:
            continue

    # Index for fast lookup
    by_ci = {r["ci"]: r for r in inner_cuts_global}

    # ---- Pass 2: for each backtest cut, tune on prior (walk-forward) inner
    # cuts, then apply the regime gate to the held-out cut's Yellen 1.1.
    for ci in cuts:
        try:
            if ci not in by_ci:
                continue
            cur = by_ci[ci]
            tme = cur["tme"]

            # Inner-CV history = all inner cuts strictly before this one
            prior = [r for r in inner_cuts_global if r["ci"] < ci]
            if len(prior) >= _INNER_CV_MIN_ROWS:
                threshold, blend_w = _tune_threshold_blend(
                    [r["yellen_yoy"] for r in prior],
                    [r["anchor_yoy"] for r in prior],
                    [r["actual_yoy"] for r in prior],
                )
            else:
                threshold, blend_w = _DEFAULT_THRESHOLD, _DEFAULT_BLEND

            yellen_yoy = float(cur["yellen_yoy"])
            anchor_yoy = float(cur["anchor_yoy"])
            actual_yoy = float(cur["actual_yoy"])

            final_yoy, anomaly_score, triggered = _apply_regime(
                yellen_yoy, anchor_yoy, threshold, blend_w
            )

            preds_yoy.append(final_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": tme.strftime("%Y-%m"),
                "as_of": cur["as_of"].strftime("%Y-%m-%d"),
                "yellen_yoy": round(yellen_yoy, 3),
                "anchor_yoy": round(anchor_yoy, 3),
                "anomaly_score": round(anomaly_score, 3),
                "threshold": round(threshold, 3),
                "blend_w": round(blend_w, 3),
                "triggered_fallback": bool(triggered),
                "pred_yoy": round(final_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(final_yoy - actual_yoy, 3),
            })
        except Exception:
            continue

    if not preds_yoy:
        return {"error": "no successful cuts"}

    py = np.asarray(preds_yoy, dtype=float)
    ay = np.asarray(actuals_yoy, dtype=float)
    yoy_err = np.abs(py - ay)
    n_trig = int(sum(1 for r in rows if r["triggered_fallback"]))
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_yoy),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "fallbackTriggered": n_trig,
        "fallbackTriggeredPct": round(100.0 * n_trig / len(rows), 1),
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Public API: live nowcast
# ---------------------------------------------------------------------------


def run_anomaly_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> AnomalyNowcastResult:
    """Live regime-aware nowcast: Yellen 1.1 with anomaly-anchor fallback."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # ---- Run Yellen 1.1 live ----
    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    F_cal, t_cal = _build_calibration_dataset(X, y, models, cols, panel, y_mom)
    ridge = _fit_calibrator(F_cal, t_cal)

    feats = rich_features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
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

    mid_cal, lo_cal, hi_cal, _bs = _apply_calibration(
        ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    yellen_yoy = _mom_to_yoy(mid_cal, last_cpi, target_month_end, cpi)
    yellen_lo80 = _mom_to_yoy(lo_cal, last_cpi, target_month_end, cpi)
    yellen_hi80 = _mom_to_yoy(hi_cal, last_cpi, target_month_end, cpi)

    # ---- Anchor + tune (use full history of cuts as inner CV) ----
    anchor_yoy = _recent_yoy_anchor(cpi, target_month_end)

    # Build inner-CV history from prior months
    inner_history: list[tuple[float, float, float]] = []
    if len(y_mom) >= 25:
        # Use the last ~24 months as inner-CV history
        n_hist = min(24, len(y_mom) - 1)
        for ci in range(len(y_mom) - n_hist, len(y_mom)):
            try:
                tme = y_mom.index[ci]
                res = _yellen_predict_for_cut(panel, daily_frame, clev, tme, as_of_day)
                if res is None:
                    continue
                a = _recent_yoy_anchor(cpi, tme)
                if not np.isfinite(a):
                    continue
                actual_cpi = float(cpi.loc[tme])
                denom_idx = tme - pd.DateOffset(years=1)
                denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
                try:
                    denom = float(cpi.loc[denom_idx])
                except KeyError:
                    denom = float(cpi.asof(denom_idx))
                ay = (actual_cpi / denom - 1.0) * 100.0
                inner_history.append((res["yellen_yoy"], a, ay))
            except Exception:
                continue

    if len(inner_history) >= _INNER_CV_MIN_ROWS:
        threshold, blend_w = _tune_threshold_blend(
            [t[0] for t in inner_history],
            [t[1] for t in inner_history],
            [t[2] for t in inner_history],
        )
    else:
        threshold, blend_w = _DEFAULT_THRESHOLD, _DEFAULT_BLEND

    final_yoy, anomaly_score, triggered = _apply_regime(
        yellen_yoy, anchor_yoy, threshold, blend_w
    )

    # Bands: shift them by the same yoy delta as the midpoint
    yoy_shift = final_yoy - yellen_yoy
    lo80_yoy = yellen_lo80 + yoy_shift
    hi80_yoy = yellen_hi80 + yoy_shift

    if (hi80_yoy - final_yoy) < _RESID_FLOOR:
        hi80_yoy = final_yoy + _RESID_FLOOR
    if (final_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = final_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return AnomalyNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,                  # report base MoM (pre-shift)
        pred_yoy=final_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        yellen_pred_yoy=yellen_yoy,
        recent_anchor_yoy=anchor_yoy if np.isfinite(anchor_yoy) else float("nan"),
        anomaly_score=anomaly_score,
        threshold_used=float(threshold),
        blend_weight=float(blend_w),
        triggered_fallback=bool(triggered),
    )
