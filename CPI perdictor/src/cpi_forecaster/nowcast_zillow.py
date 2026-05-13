"""Quantile_rich + Cleveland Fed + Zillow ZORI rent leading indicator.

Strategy: take everything `nowcast_clev.py` already does (quantile_rich
features + Cleveland Fed nowcast + FRED median CPI fallback) and ADD the
Zillow Observed Rent Index (ZORI) at lag-0, lag-6 and lag-12 months.

Why: shelter is ~33% of CPI — the LARGEST component by weight. BLS
measures shelter via Owners' Equivalent Rent and tenant lease prices,
both of which lag market rents by 6-12 months because BLS re-surveys
existing leases that were typically signed months ago. Zillow's ZORI
uses asking rents on actively-listed units, so it captures the marginal
rent buyer's experience NOW. ZORI changes today should predict BLS
shelter changes 6-12 months from now.

For our nowcast (which targets the next CPI print), the most useful
signal is Zillow ZORI from 6-12 months ago — that's what the BLS shelter
component is "catching up" to. We expose:

  zori_yoy_lag0   — most recent Zillow YoY (rent momentum NOW)
  zori_yoy_lag6   — Zillow YoY 6 months ago
  zori_yoy_lag12  — Zillow YoY 12 months ago (best fit for current BLS shelter)
  zori_mom_lag0   — recent monthly rent change (rent acceleration signal)
  zori_yoy_minus_lag12 — current Zillow YoY minus a year ago (rent disinflation)
  zori_used_scrape — 1 if real ZORI, 0 if Case-Shiller fallback

The Zillow scrape can fall back to FRED Case-Shiller (home prices) on
the server side. That's a weaker signal — home prices and rents are
correlated but not the same thing. We surface `usedZillowScrape` in the
backtest result so we can be honest about whether the leading-indicator
hypothesis is actually being tested vs. a degraded proxy is being used.

Public API:
  backtest_zillow_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_zillow_nowcast(as_of_day=20) -> ZillowNowcastResult

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel, get_cleveland_nowcast, get_zillow_rent
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import _clev_features_for_month, _safe_get_clev
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


@dataclass
class ZillowNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_zillow_scrape: bool
    zillow_source: str | None


# ---------------------------------------------------------------------------
# Zillow-feature helpers
# ---------------------------------------------------------------------------


def _safe_get_zillow() -> dict:
    """Fetch Zillow rent feed via API. Always returns a dict (never raises)."""
    try:
        return get_zillow_rent()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "source": None,
            "usedFallback": False,
            "history": [],
            "error": str(exc),
        }


def _zillow_history_to_series(zori: dict) -> pd.DataFrame | None:
    """Convert API `history` list to a date-indexed DataFrame.

    Returns None if the response isn't usable. Index = month-end timestamps
    so it lines up with our CPI panel. Columns: level, yoy, mom.
    """
    if not isinstance(zori, dict):
        return None
    if not zori.get("ok"):
        return None
    hist = zori.get("history") or []
    if not isinstance(hist, list) or len(hist) < 13:
        return None
    rows: list[dict] = []
    for entry in hist:
        if not isinstance(entry, dict):
            continue
        d = entry.get("date")
        if not isinstance(d, str):
            continue
        try:
            ts = pd.Timestamp(d) + pd.offsets.MonthEnd(0)
        except Exception:
            continue
        level = entry.get("level")
        yoy = entry.get("yoy")
        mom = entry.get("mom")
        rows.append({
            "month_end": ts,
            "level": float(level) if isinstance(level, (int, float)) else np.nan,
            "yoy": float(yoy) if isinstance(yoy, (int, float)) else np.nan,
            "mom": float(mom) if isinstance(mom, (int, float)) else np.nan,
        })
    if not rows:
        return None
    df = pd.DataFrame(rows).drop_duplicates(subset=["month_end"]).set_index("month_end")
    df = df.sort_index()
    return df


def _zillow_features_for_month(
    zori_df: pd.DataFrame | None,
    target_month_end: pd.Timestamp,
    is_scrape: bool,
) -> dict[str, float]:
    """Build Zillow ZORI features for one target month.

    For target month M, the model only gets to see Zillow data published
    BEFORE we forecast (i.e. data for months <= M-1, since Zillow's M
    publication usually lands after the BLS CPI release for M).

    Returned features:
      zori_yoy_lag0   — Zillow YoY at the most recent month <= M-1
      zori_yoy_lag6   — Zillow YoY 6 months earlier
      zori_yoy_lag12  — Zillow YoY 12 months earlier (best lead for shelter)
      zori_mom_lag0   — most recent MoM (rent acceleration signal)
      zori_yoy_minus_lag12 — current YoY minus a year ago (deceleration)
      zori_used_scrape — 1 if real ZORI / 0 if fallback or missing
    """
    feats: dict[str, float] = {
        "zori_yoy_lag0": np.nan,
        "zori_yoy_lag6": np.nan,
        "zori_yoy_lag12": np.nan,
        "zori_mom_lag0": np.nan,
        "zori_yoy_minus_lag12": np.nan,
        "zori_used_scrape": 1.0 if is_scrape else 0.0,
    }
    if zori_df is None or zori_df.empty:
        feats["zori_used_scrape"] = 0.0
        return feats

    # Only use Zillow data strictly before the target month — this mirrors
    # what we'd actually have at as-of-day-20 (Zillow's publication lag
    # is at least a couple weeks, often a full month).
    cutoff = target_month_end + pd.offsets.MonthEnd(-1)
    avail = zori_df.loc[zori_df.index <= cutoff]
    if avail.empty:
        return feats

    last = avail.iloc[-1]
    if np.isfinite(last.get("yoy", np.nan)):
        feats["zori_yoy_lag0"] = float(last["yoy"])
    if np.isfinite(last.get("mom", np.nan)):
        feats["zori_mom_lag0"] = float(last["mom"])

    if len(avail) >= 7:
        lag6 = avail.iloc[-7]
        if np.isfinite(lag6.get("yoy", np.nan)):
            feats["zori_yoy_lag6"] = float(lag6["yoy"])
    if len(avail) >= 13:
        lag12 = avail.iloc[-13]
        if np.isfinite(lag12.get("yoy", np.nan)):
            feats["zori_yoy_lag12"] = float(lag12["yoy"])
            if np.isfinite(feats["zori_yoy_lag0"]):
                feats["zori_yoy_minus_lag12"] = (
                    feats["zori_yoy_lag0"] - feats["zori_yoy_lag12"]
                )

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_zillow(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    zori_df: pd.DataFrame | None,
    is_zillow_scrape: bool,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich + Cleveland + Zillow features per month."""
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

        # Cleveland nowcast features
        try:
            feats.update(_clev_features_for_month(clev, month_end, panel))
        except Exception:
            pass

        # Zillow ZORI features (lag-0/6/12 of YoY + lag-0 MoM)
        try:
            feats.update(
                _zillow_features_for_month(zori_df, month_end, is_zillow_scrape)
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


def backtest_zillow_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest: quantile_rich + Cleveland + Zillow ZORI.

    Calls each scrape ONCE up-front (not per cut) — both the Cleveland
    historical archive and Zillow's history list cover all cuts.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok") and clev.get("historical"))

    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )
    zillow_source = zori.get("source") if isinstance(zori, dict) else None

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

            X, y = _build_supervised_zillow(
                train_panel,
                daily_frame,
                clev,
                zori_df,
                used_zillow,
                as_of_day=as_of_day,
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
            try:
                feats.update(
                    _zillow_features_for_month(zori_df, target_month_end, used_zillow)
                )
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
        "usedClevScrape": used_clev,
        "usedZillowScrape": used_zillow,
        "zillowSource": zillow_source,
        "rows": rows,
    }


def run_zillow_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> ZillowNowcastResult:
    """Live nowcast using fresh Cleveland + Zillow scrapes + quantile_rich stack."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok"))

    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )
    zillow_source = zori.get("source") if isinstance(zori, dict) else None

    X, y = _build_supervised_zillow(
        panel, daily_frame, clev, zori_df, used_zillow, as_of_day=as_of_day,
    )
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
    try:
        feats.update(
            _zillow_features_for_month(zori_df, target_month_end, used_zillow)
        )
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
    return ZillowNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_clev,
        used_zillow_scrape=used_zillow,
        zillow_source=zillow_source,
    )
