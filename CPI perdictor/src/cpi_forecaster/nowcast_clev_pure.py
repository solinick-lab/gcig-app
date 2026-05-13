"""Pure Cleveland Fed baseline — no ML model.

For every cut, look up Cleveland Fed's vintage-correct nowcast for the
target month from the historical archive returned by
`get_cleveland_nowcast()` and use it DIRECTLY as the prediction.

Why: tests whether Cleveland's published number alone outperforms our
ML enhancements (target to beat: 0.1142 MAE on YoY).

Strategy per cut:
  1. Look up `historical[YYYY-MM]` for the target month — this is
     Cleveland's day-20 vintage YoY/MoM nowcast.
  2. Use the YoY value as `pred_yoy` directly.
  3. Use the MoM value as `pred_mom` directly. If MoM is missing,
     back it out from YoY using the train-tail CPI level.
  4. If the historical archive lookup fails, fall back to the live
     `headline.currentMonth` slot when month matches; otherwise skip
     the cut (we don't fabricate predictions).

No supervised dataset, no GBR/quantile models, no calibration. Just
Cleveland's number as the answer. Same I/O contract as `nowcast_clev`.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .api_client import get_daily_panel, get_cleveland_nowcast
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05
# Symmetric YoY band fallback when we have no model uncertainty.
_DEFAULT_BAND_BP = 0.20


@dataclass
class ClevPureNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Cleveland helpers
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


def _clev_lookup_for_month(
    clev: dict,
    target_month_end: pd.Timestamp,
) -> tuple[float, float, bool]:
    """Return (yoy, mom, found) from Cleveland for a target month.

    Tries the historical archive first (vintage-correct), falls back to
    live `headline.currentMonth`/`nextMonth` slots when month matches.
    Returns (nan, nan, False) when nothing is available.
    """
    target_key = target_month_end.strftime("%Y-%m")
    yoy = np.nan
    mom = np.nan
    found = False

    if not (isinstance(clev, dict) and clev.get("ok")):
        return yoy, mom, found

    hist = clev.get("historical") or {}
    if isinstance(hist, dict) and target_key in hist:
        entry = hist[target_key] or {}
        v_yoy = entry.get("yoy")
        v_mom = entry.get("mom")
        if isinstance(v_yoy, (int, float)) and np.isfinite(v_yoy):
            yoy = float(v_yoy)
            found = True
        if isinstance(v_mom, (int, float)) and np.isfinite(v_mom):
            mom = float(v_mom)
            found = True
        if found:
            return yoy, mom, True

    # Live slots — only valid when the slot's month matches our target.
    for slot in ("currentMonth", "nextMonth"):
        head = clev.get("headline", {}).get(slot) or {}
        if head.get("month") != target_key:
            continue
        v_yoy = head.get("yoy")
        v_mom = head.get("mom")
        if isinstance(v_yoy, (int, float)) and np.isfinite(v_yoy):
            yoy = float(v_yoy)
            found = True
        if isinstance(v_mom, (int, float)) and np.isfinite(v_mom):
            mom = float(v_mom)
            found = True
        if found:
            return yoy, mom, True

    return yoy, mom, found


def _yoy_to_mom(
    pred_yoy: float,
    last_cpi_train: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Recover implied MoM (%) from YoY (%) and last released CPI."""
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    implied_cpi = denom * (1.0 + pred_yoy / 100.0)
    if last_cpi_train <= 0:
        return float("nan")
    return float(np.log(implied_cpi / last_cpi_train) * 100.0)


def _mom_to_yoy(
    pred_mom: float,
    last_cpi_train: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    predicted_cpi = last_cpi_train * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return float((predicted_cpi / denom - 1.0) * 100.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_clev_pure_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using Cleveland Fed's nowcast as the prediction.

    No model, no fitting — just a vintage-correct lookup per month.
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
            if len(train_panel) < 13:
                continue

            yoy, mom, found = _clev_lookup_for_month(clev, target_month_end)
            if not found or not np.isfinite(yoy):
                # No Cleveland number for this vintage — skip the cut. We do
                # NOT fabricate a fallback; the whole point is to test the
                # raw Cleveland baseline.
                continue

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])

            # Recover MoM from YoY when MoM missing.
            if not np.isfinite(mom):
                mom = _yoy_to_mom(yoy, last_cpi_train, target_month_end, cpi)
            mom = float(np.clip(mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Use Cleveland's YoY directly (no clipping — already in a
            # reasonable range and clipping would distort the test).
            pred_yoy = float(yoy)

            actual_mom = float(y_mom.iloc[ci])
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = float((actual_cpi / denom - 1.0) * 100.0)

            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)

            preds_mom.append(mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
            })
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts (no Cleveland historical archive)"}

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


def run_clev_pure_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> ClevPureNowcastResult:
    """Live nowcast: return Cleveland Fed's headline current-month number directly."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    yoy, mom, found = _clev_lookup_for_month(clev, target_month_end)

    last_cpi = float(cpi.iloc[-1])

    if found and np.isfinite(yoy):
        pred_yoy = float(yoy)
        if not np.isfinite(mom):
            mom = _yoy_to_mom(pred_yoy, last_cpi, target_month_end, cpi)
        pred_mom = float(np.clip(mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
    else:
        # Cleveland unavailable — naive carry: assume YoY equals last
        # released YoY. We mark the result accordingly.
        if len(cpi) >= 13:
            pred_yoy = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
        else:
            pred_yoy = 0.0
        pred_mom = 0.0
        used_scrape = False

    # No model uncertainty — emit a fixed +/- band so the result still
    # plays nice with downstream consumers expecting lo80/hi80.
    lo80_yoy = pred_yoy - _DEFAULT_BAND_BP
    hi80_yoy = pred_yoy + _DEFAULT_BAND_BP
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return ClevPureNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
