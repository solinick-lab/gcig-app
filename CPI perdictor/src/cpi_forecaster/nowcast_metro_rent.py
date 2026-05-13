"""Quantile_rich + Cleveland Fed + metro-level Zillow ZORI features.

Strategy: same backbone as `nowcast_zillow.py` (quantile_rich + Cleveland
Fed nowcast + GBR @ q={0.1, 0.5, 0.9}) but the rent feature is the
average of metro-level Zillow YoYs at lag-12 across the top-5 BLS-weighted
urban areas (NYC, LA, Chicago, Houston, Dallas).

Why: BLS shelter weights are population-weighted across CPI urban areas.
The national ZORI is a Zillow-internal aggregate that doesn't necessarily
match BLS's basket — major metros drive most of the variance in BLS
shelter, and metro-level rents may capture earlier signal than the
national aggregate (different rent cycles, e.g. coastal markets vs.
sunbelt). At lag-12 we're forecasting how much BLS shelter is "catching
up" to rents that were posted a year ago in the metros that dominate
the urban CPI basket.

Features added on top of quantile_rich + Cleveland:
  metro_rent_yoy_lag12      — average of {NYC, LA, Chicago, Houston, Dallas} ZORI YoY 12 months ago
  metro_rent_yoy_lag0       — same average, at the most recent month <= M-1
  metro_rent_yoy_minus_lag12 — current minus lag-12 (rent disinflation across the basket)
  metro_rent_n_used         — how many metros (out of 5) actually contributed (0..5)
  metro_rent_used_scrape    — 1 if metro CSV parsed, 0 if fallback path taken

Server feed shape (see /api/cpi/zillow-rent):
    {
      "ok": bool,
      "national": { "history": [{date, level, yoy, mom}, ...] },
      "metros":   { "<Metro>": { "history": [{date, level, yoy, mom}, ...] }, ... }
    }

If the metro block is missing or empty, this strategy degrades gracefully:
features become NaN and the supervised builder fills with the column
median, so the model effectively reduces to quantile_rich + Cleveland.

Public API:
  backtest_metro_rent_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_metro_rent_nowcast(as_of_day=20) -> MetroRentNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel, get_zillow_rent
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

# Top-5 metros (BLS-weighted urban areas). These keys must match the keys
# the server emits in `metros`.
_TOP5_METROS = ("New York", "Los Angeles", "Chicago", "Houston", "Dallas")


@dataclass
class MetroRentNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_metro_scrape: bool
    metros_available: int


# ---------------------------------------------------------------------------
# Zillow metro helpers
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
            "metros": {},
            "error": str(exc),
        }


def _history_to_yoy_series(hist: list) -> pd.Series | None:
    """Convert a list of {date, yoy, ...} entries to a date-indexed YoY series."""
    if not isinstance(hist, list) or len(hist) < 13:
        return None
    rows: list[tuple[pd.Timestamp, float]] = []
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
        yoy = entry.get("yoy")
        if not isinstance(yoy, (int, float)):
            continue
        if not np.isfinite(float(yoy)):
            continue
        rows.append((ts, float(yoy)))
    if not rows:
        return None
    s = pd.Series(
        [v for _, v in rows],
        index=pd.DatetimeIndex([t for t, _ in rows]),
    ).sort_index()
    s = s[~s.index.duplicated(keep="last")]
    return s


def _metro_yoy_frame(zori: dict) -> tuple[pd.DataFrame | None, bool]:
    """Build a DataFrame with one column per top-5 metro of YoY values.

    Returns (df, used_scrape). df is None if no metros parsed at all
    (in which case the model falls back to quantile_rich + Cleveland only).
    used_scrape indicates whether real metro data made it through.
    """
    if not isinstance(zori, dict) or not zori.get("ok"):
        return None, False
    metros = zori.get("metros") or {}
    if not isinstance(metros, dict) or not metros:
        return None, False

    cols: dict[str, pd.Series] = {}
    for metro in _TOP5_METROS:
        block = metros.get(metro)
        if not isinstance(block, dict):
            continue
        s = _history_to_yoy_series(block.get("history") or [])
        if s is None or s.empty:
            continue
        cols[metro] = s

    if not cols:
        return None, False

    df = pd.DataFrame(cols).sort_index()
    return df, True


def _metro_features_for_month(
    metro_df: pd.DataFrame | None,
    target_month_end: pd.Timestamp,
    is_scrape: bool,
) -> dict[str, float]:
    """Build top-5 metro YoY features for a target month.

    For target month M we use Zillow data with index <= M-1 month-end.
    We compute the cross-metro mean of YoY at lag-0 and at lag-12, plus
    the difference (deceleration) and the count of metros that
    contributed.
    """
    feats: dict[str, float] = {
        "metro_rent_yoy_lag12": np.nan,
        "metro_rent_yoy_lag0": np.nan,
        "metro_rent_yoy_minus_lag12": np.nan,
        "metro_rent_n_used": 0.0,
        "metro_rent_used_scrape": 1.0 if is_scrape else 0.0,
    }
    if metro_df is None or metro_df.empty:
        feats["metro_rent_used_scrape"] = 0.0
        return feats

    cutoff = target_month_end + pd.offsets.MonthEnd(-1)
    avail = metro_df.loc[metro_df.index <= cutoff]
    if avail.empty:
        return feats

    last = avail.iloc[-1]
    # Mean across metros where YoY is finite at lag-0
    finite_last = last.dropna()
    n_used = int(finite_last.shape[0])
    feats["metro_rent_n_used"] = float(n_used)
    if n_used > 0:
        feats["metro_rent_yoy_lag0"] = float(finite_last.mean())

    if len(avail) >= 13:
        lag12 = avail.iloc[-13]
        finite_lag12 = lag12.dropna()
        if not finite_lag12.empty:
            feats["metro_rent_yoy_lag12"] = float(finite_lag12.mean())
            if np.isfinite(feats["metro_rent_yoy_lag0"]):
                feats["metro_rent_yoy_minus_lag12"] = (
                    feats["metro_rent_yoy_lag0"] - feats["metro_rent_yoy_lag12"]
                )

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_metro(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    metro_df: pd.DataFrame | None,
    is_metro_scrape: bool,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich + Cleveland + metro-rent features per month."""
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

        # Metro-level Zillow features (top-5 metro avg YoY at lag-0 and lag-12)
        try:
            feats.update(
                _metro_features_for_month(metro_df, month_end, is_metro_scrape)
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


def _predict_triple(
    models: dict, x_inf: pd.Series, cols: list[str]
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


def backtest_metro_rent_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest: quantile_rich + Cleveland + top-5 metro rent."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok") and clev.get("historical"))

    zori = _safe_get_zillow()
    metro_df, used_metro = _metro_yoy_frame(zori)
    n_metros = int(metro_df.shape[1]) if metro_df is not None else 0

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

            X, y = _build_supervised_metro(
                train_panel,
                daily_frame,
                clev,
                metro_df,
                used_metro,
                as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

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
                    _metro_features_for_month(metro_df, target_month_end, used_metro)
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
        "usedMetroScrape": used_metro,
        "metrosAvailable": n_metros,
        "rows": rows,
    }


def run_metro_rent_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> MetroRentNowcastResult:
    """Live nowcast using fresh Cleveland + Zillow metro scrapes + quantile_rich."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok"))

    zori = _safe_get_zillow()
    metro_df, used_metro = _metro_yoy_frame(zori)
    n_metros = int(metro_df.shape[1]) if metro_df is not None else 0

    X, y = _build_supervised_metro(
        panel, daily_frame, clev, metro_df, used_metro, as_of_day=as_of_day,
    )
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        (last_released_month_end + pd.offsets.MonthBegin(1))
        + pd.offsets.MonthEnd(0)
    )
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
            _metro_features_for_month(metro_df, target_month_end, used_metro)
        )
    except Exception:
        pass

    x_inf = (
        pd.Series(feats)
        .reindex(cols)
        .fillna(X.median(numeric_only=True))
        .fillna(0.0)
    )
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
    return MetroRentNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_clev,
        used_metro_scrape=used_metro,
        metros_available=n_metros,
    )
