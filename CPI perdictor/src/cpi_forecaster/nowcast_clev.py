"""Quantile_rich + Cleveland Fed Inflation Nowcast features.

Strategy: stand on Cleveland Fed's shoulders. Their inflation nowcast is
already a strong predictor — recent vintages of headline-CPI nowcast YoY
are typically within ~10-15 bps of the eventual BLS print, especially in
the back half of the month. We use it as a direct feature in our
quantile_rich GBR stack.

Two sources of Cleveland data:
  1. Live nowcast (current/next month) — `get_cleveland_nowcast()` from
     api_client. Returns the LATEST values scraped from the Cleveland
     Fed page.
  2. Historical archive — included in the same scrape response under
     `historical[YYYY-MM]`. For each past month, this is Cleveland's
     nowcast value as published on day-20 of that month (the typical
     as_of_day for our nowcaster). Letting the model train on prior
     Cleveland nowcasts is what lets the backtest be realistic.

Fallback: if the scrape fails (`ok: false` or empty `historical`), we
DON'T silently degrade — instead we use the FRED Cleveland Median CPI
(MEDCPIM158SFRBCLE) values that are already in the panel as a smoothed
proxy feature. That alone won't match the live nowcast quality, but it
keeps the model viable when scraping is down.

Public API:
  backtest_clev_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_clev_nowcast(as_of_day=20) -> NowcastResult-shaped object

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].
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

# FRED median CPI (already in panel via EXTRA_SERIES). Used as fallback
# when the Cleveland scrape is unavailable.
_FRED_MED_CPI = "MEDCPIM158SFRBCLE"


@dataclass
class ClevNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Cleveland-feature helpers
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


def _clev_features_for_month(
    clev: dict,
    target_month_end: pd.Timestamp,
    panel: pd.DataFrame,
) -> dict[str, float]:
    """Build Cleveland-derived features for one target month.

    `target_month_end` = month we're forecasting. We want Cleveland's
    nowcast for THAT month (and the next-month nowcast as an additional
    signal of recent momentum).

    Strategy:
      1. Try the historical archive at `historical[YYYY-MM]`. This is
         Cleveland's day-20 nowcast for that month — the right vintage
         for our as-of-day-20 simulation.
      2. If the live `headline.currentMonth.month` matches `target_month`
         (we're nowcasting the live current month), use the live value.
      3. Fallback: use FRED median CPI from the panel as a proxy.

    Returned feature names:
      clev_yoy, clev_mom, clev_core_yoy, clev_core_mom
      clev_next_yoy, clev_next_mom (when available)
      clev_used_scrape (1 if from scrape, 0 if from FRED-median fallback)
      clev_yoy_minus_lag (today's nowcast YoY minus lag1 YoY — momentum proxy)
    """
    feats: dict[str, float] = {
        "clev_yoy": np.nan,
        "clev_mom": np.nan,
        "clev_core_yoy": np.nan,
        "clev_core_mom": np.nan,
        "clev_next_yoy": np.nan,
        "clev_next_mom": np.nan,
        "clev_used_scrape": 0.0,
    }

    target_key = target_month_end.strftime("%Y-%m")
    used_scrape = False

    if isinstance(clev, dict) and clev.get("ok"):
        # First try historical archive
        hist = clev.get("historical") or {}
        if isinstance(hist, dict) and target_key in hist:
            entry = hist[target_key] or {}
            yoy = entry.get("yoy")
            mom = entry.get("mom")
            cyoy = entry.get("coreYoy")
            cmom = entry.get("coreMom")
            if isinstance(yoy, (int, float)) and np.isfinite(yoy):
                feats["clev_yoy"] = float(yoy)
                used_scrape = True
            if isinstance(mom, (int, float)) and np.isfinite(mom):
                feats["clev_mom"] = float(mom)
                used_scrape = True
            if isinstance(cyoy, (int, float)) and np.isfinite(cyoy):
                feats["clev_core_yoy"] = float(cyoy)
            if isinstance(cmom, (int, float)) and np.isfinite(cmom):
                feats["clev_core_mom"] = float(cmom)
            # Next-month nowcast (if Cleveland publishes one — typically only
            # late in the current month after BLS releases prior CPI).
            next_end = target_month_end + pd.offsets.MonthEnd(1)
            next_key = next_end.strftime("%Y-%m")
            if next_key in hist:
                nxt = hist[next_key] or {}
                if isinstance(nxt.get("yoy"), (int, float)):
                    feats["clev_next_yoy"] = float(nxt["yoy"])
                if isinstance(nxt.get("mom"), (int, float)):
                    feats["clev_next_mom"] = float(nxt["mom"])

        # If we didn't find a historical entry, see if the LIVE current/next
        # entries match this target month (i.e. we're forecasting "now").
        if not used_scrape:
            for slot in ("currentMonth", "nextMonth"):
                head = clev.get("headline", {}).get(slot) or {}
                core = clev.get("core", {}).get(slot) or {}
                if head.get("month") == target_key:
                    if isinstance(head.get("yoy"), (int, float)):
                        feats["clev_yoy"] = float(head["yoy"])
                        used_scrape = True
                    if isinstance(head.get("mom"), (int, float)):
                        feats["clev_mom"] = float(head["mom"])
                    if isinstance(core.get("yoy"), (int, float)):
                        feats["clev_core_yoy"] = float(core["yoy"])
                    if isinstance(core.get("mom"), (int, float)):
                        feats["clev_core_mom"] = float(core["mom"])
                    # Also pull the OTHER slot as the "next" features
                    other_slot = "nextMonth" if slot == "currentMonth" else "currentMonth"
                    other_head = clev.get("headline", {}).get(other_slot) or {}
                    if isinstance(other_head.get("yoy"), (int, float)):
                        feats["clev_next_yoy"] = float(other_head["yoy"])
                    if isinstance(other_head.get("mom"), (int, float)):
                        feats["clev_next_mom"] = float(other_head["mom"])
                    break

    if used_scrape:
        feats["clev_used_scrape"] = 1.0
    else:
        # Fallback: FRED median CPI proxy. We give it a STRONGER weight by
        # exposing both YoY level and MoM change of the median series. The
        # latest available median is the prior month's release (BLS-aligned).
        try:
            if _FRED_MED_CPI in panel.columns:
                s = panel[_FRED_MED_CPI].dropna()
                last_released = (
                    target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
                ) + pd.offsets.MonthEnd(0)
                prior = s.loc[s.index <= last_released]
                if len(prior) >= 13:
                    med_yoy = float((prior.iloc[-1] / prior.iloc[-13] - 1.0) * 100.0)
                    med_mom = float((prior.iloc[-1] / prior.iloc[-2] - 1.0) * 100.0) if prior.iloc[-2] != 0 else np.nan
                    # 3-month moving average of MoM (smoother momentum)
                    if len(prior) >= 5:
                        moms = (prior.iloc[-3:].values / prior.iloc[-4:-1].values - 1.0) * 100.0
                        med_mom_3m = float(np.mean(moms))
                    else:
                        med_mom_3m = med_mom
                    # Use median YoY as a (poor) stand-in for clev_yoy. Add
                    # the BLS-vs-median wedge (a stable inflation-noise proxy).
                    cpi = panel[TARGET.fred_id].dropna()
                    cpi_prior = cpi.loc[cpi.index <= last_released]
                    if len(cpi_prior) >= 13:
                        head_yoy = float(
                            (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0
                        )
                        wedge = head_yoy - med_yoy
                    else:
                        wedge = 0.0
                    # Best-guess: clev_yoy ~= median_yoy + wedge (recover an
                    # estimate of headline YoY trajectory). This is a STRONG
                    # informative prior even without the scrape.
                    feats["clev_yoy"] = med_yoy + wedge
                    feats["clev_mom"] = med_mom_3m
                    feats["clev_core_yoy"] = med_yoy
                    feats["clev_core_mom"] = med_mom
        except Exception:
            pass

    # Momentum feature: latest YoY vs last-released CPI YoY. This captures
    # whether Cleveland thinks inflation is accelerating/decelerating
    # relative to last month's released BLS print.
    try:
        cpi = panel[TARGET.fred_id].dropna()
        last_released = (
            target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
        ) + pd.offsets.MonthEnd(0)
        cpi_prior = cpi.loc[cpi.index <= last_released]
        if len(cpi_prior) >= 13 and np.isfinite(feats["clev_yoy"]):
            lag_yoy = float((cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0)
            feats["clev_yoy_minus_lag"] = feats["clev_yoy"] - lag_yoy
        else:
            feats["clev_yoy_minus_lag"] = np.nan
    except Exception:
        feats["clev_yoy_minus_lag"] = np.nan

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_clev(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich features + Cleveland nowcast features per month."""
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

        # Cleveland nowcast features for THIS training row
        try:
            feats.update(_clev_features_for_month(clev, month_end, panel))
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
# Fit / predict
# ---------------------------------------------------------------------------


def _fit_quantile_models(X: pd.DataFrame, y: pd.Series) -> dict:
    """Fit q={0.1, 0.5, 0.9} GBR. Each one independently."""
    models = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(X.values, y.values)
    return models


def _predict_triple(models: dict, x_inf: pd.Series, cols: list[str]) -> tuple[float, float, float]:
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


def backtest_clev_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using quantile_rich + Cleveland nowcast features.

    Calls the scrape ONCE up-front (not per cut) — the historical archive
    in that single response covers all cuts.
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

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # Inference features
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
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

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            mid, lo, hi = _predict_triple(models, x_inf, cols)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
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


def run_clev_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> ClevNowcastResult:
    """Live nowcast using fresh Cleveland scrape + quantile_rich stack."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
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
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return ClevNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
