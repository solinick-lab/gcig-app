"""Quantile_rich + Cleveland Fed + Truflation features.

Strategy: take everything ``nowcast_clev`` already builds (quantile_rich
features + Cleveland Fed nowcast features) and add Truflation's daily
real-time inflation index as additional features. Truflation claims to
lead BLS headline CPI by ~30 days, so its day-20 YoY/MoM should be a
strong predictor of the upcoming BLS print.

Two sources of Truflation data:
  1. Live latest YoY/MoM from the scrape — used for the "current month"
     nowcast.
  2. Historical daily series (`seriesYoy`, `seriesLevel`) — for each
     prior backtest cut, we look up the index value AT day-`as_of_day`
     of that month, exactly as it would have looked during real-time
     forecasting.

Fallback: if the scrape fails (`ok: false` or empty `seriesYoy`), we
silently fall back to clev_nowcast's feature set only, so the strategy
remains viable even when Truflation is down.

Public API:
  backtest_truflation_nowcast(panel, daily_frame, window_months=24,
                              as_of_day=20) -> dict
  run_truflation_nowcast(as_of_day=20) -> TruflationNowcastResult

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import (
    get_daily_panel,
    get_cleveland_nowcast,
    get_truflation_feed,
)
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
class TruflationNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_truflation_scrape: bool


# ---------------------------------------------------------------------------
# Truflation helpers
# ---------------------------------------------------------------------------


def _safe_get_truflation() -> dict:
    """Fetch Truflation feed via API. Always returns a dict (never raises)."""
    try:
        return get_truflation_feed()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "yoy": None,
            "mom": None,
            "history": [],
            "seriesYoy": {},
            "seriesLevel": {},
            "error": str(exc),
        }


def _truflation_series_to_pd(truf: dict, key: str) -> pd.Series:
    """Convert seriesYoy/seriesLevel dict into a sorted pd.Series."""
    s_dict = truf.get(key) or {}
    if not isinstance(s_dict, dict) or not s_dict:
        return pd.Series(dtype=float)
    try:
        idx = pd.to_datetime(list(s_dict.keys()), errors="coerce")
        vals = pd.to_numeric(list(s_dict.values()), errors="coerce")
        s = pd.Series(vals, index=idx).dropna()
        s = s[~s.index.isna()].sort_index()
        return s
    except Exception:
        return pd.Series(dtype=float)


def _value_on_or_before(s: pd.Series, anchor: pd.Timestamp) -> float:
    """Latest series value with index <= anchor; NaN if none."""
    if s.empty:
        return float("nan")
    sub = s.loc[s.index <= anchor]
    if sub.empty:
        return float("nan")
    return float(sub.iloc[-1])


def _truflation_features_for_month(
    truf: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    yoy_series: pd.Series,
    level_series: pd.Series,
) -> dict[str, float]:
    """Build Truflation-derived features for one target month.

    All features are computed AS-OF day-`as_of_day` of the target month
    (or its month-start + as_of_day, more precisely) — i.e. the value
    that Truflation would have published by that point. Strict point-in-
    time discipline matches the as_of convention used elsewhere in this
    codebase.

    Feature set:
      truf_yoy            — Truflation YoY% as-of day-N
      truf_mom            — Truflation MoM% as-of day-N (level/level_priorEOM)
      truf_yoy_minus_lag  — truf_yoy minus last released BLS-CPI YoY
      truf_yoy_change_30d — change in YoY over the past 30 days (momentum)
      truf_yoy_change_60d — change in YoY over the past 60 days
      truf_yoy_avg_30d    — 30-day rolling mean of YoY
      truf_used_scrape    — 1 if these features come from the scrape, 0 else
    """
    feats: dict[str, float] = {
        "truf_yoy": np.nan,
        "truf_mom": np.nan,
        "truf_yoy_minus_lag": np.nan,
        "truf_yoy_change_30d": np.nan,
        "truf_yoy_change_60d": np.nan,
        "truf_yoy_avg_30d": np.nan,
        "truf_used_scrape": 0.0,
    }

    if yoy_series.empty:
        return feats

    # As-of timestamp for THIS target month
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)

    truf_yoy = _value_on_or_before(yoy_series, as_of)
    if not np.isfinite(truf_yoy):
        return feats

    feats["truf_yoy"] = truf_yoy
    feats["truf_used_scrape"] = 1.0

    # MoM from level series: today_level / last_priormonth_eom_level - 1
    if not level_series.empty:
        today_level = _value_on_or_before(level_series, as_of)
        prior_eom = (target_month_end + pd.offsets.MonthBegin(-1)
                     - pd.Timedelta(days=1))
        prior_level = _value_on_or_before(level_series, prior_eom)
        if (np.isfinite(today_level) and np.isfinite(prior_level)
                and prior_level != 0):
            feats["truf_mom"] = float(
                (today_level / prior_level - 1.0) * 100.0
            )

    # Momentum: change in YoY vs 30/60 days ago
    yoy_30d_ago = _value_on_or_before(yoy_series, as_of - pd.Timedelta(days=30))
    yoy_60d_ago = _value_on_or_before(yoy_series, as_of - pd.Timedelta(days=60))
    if np.isfinite(yoy_30d_ago):
        feats["truf_yoy_change_30d"] = truf_yoy - yoy_30d_ago
    if np.isfinite(yoy_60d_ago):
        feats["truf_yoy_change_60d"] = truf_yoy - yoy_60d_ago

    # 30-day rolling average of YoY ending at as_of
    try:
        win_start = as_of - pd.Timedelta(days=30)
        window = yoy_series.loc[(yoy_series.index >= win_start)
                                & (yoy_series.index <= as_of)]
        if len(window) >= 5:
            feats["truf_yoy_avg_30d"] = float(window.mean())
    except Exception:
        pass

    return feats


def _truf_yoy_minus_lag(
    feats: dict,
    panel: pd.DataFrame,
    target_month_end: pd.Timestamp,
) -> dict:
    """Add truf_yoy_minus_lag using last released BLS CPI YoY."""
    try:
        if not np.isfinite(feats.get("truf_yoy", np.nan)):
            return feats
        cpi = panel[TARGET.fred_id].dropna()
        last_released = (
            target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
        ) + pd.offsets.MonthEnd(0)
        cpi_prior = cpi.loc[cpi.index <= last_released]
        if len(cpi_prior) >= 13:
            lag_yoy = float(
                (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0
            )
            feats["truf_yoy_minus_lag"] = float(feats["truf_yoy"] - lag_yoy)
    except Exception:
        pass
    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    truf: dict,
    yoy_series: pd.Series,
    level_series: pd.Series,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich + Cleveland + Truflation features per training month."""
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

        # Lag features
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

        # Truflation features
        try:
            tfeats = _truflation_features_for_month(
                truf, month_end, as_of_day, yoy_series, level_series,
            )
            tfeats = _truf_yoy_minus_lag(tfeats, panel, month_end)
            feats.update(tfeats)
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
    """Fit q={0.1, 0.5, 0.9} GBR. Each independently."""
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


def backtest_truflation_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest. Cleveland scrape + Truflation scrape called ONCE
    each up front; their historical archives cover all cuts.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok") and clev.get("historical"))

    truf = _safe_get_truflation()
    yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    level_series = _truflation_series_to_pd(truf, "seriesLevel")
    used_truf = bool(truf.get("ok") and not yoy_series.empty)

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

            X, y = _build_supervised(
                train_panel,
                daily_frame,
                clev,
                truf,
                yoy_series,
                level_series,
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
            feats["cpi_mom_lag2"] = (
                float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            )
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0)
                * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

            # Cleveland features
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            # Truflation features
            try:
                tfeats = _truflation_features_for_month(
                    truf, target_month_end, as_of_day, yoy_series, level_series,
                )
                tfeats = _truf_yoy_minus_lag(tfeats, panel, target_month_end)
                feats.update(tfeats)
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
        "usedTruflationScrape": used_truf,
        "rows": rows,
    }


def run_truflation_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> TruflationNowcastResult:
    """Live nowcast using fresh Cleveland + Truflation scrapes."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok"))

    truf = _safe_get_truflation()
    yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    level_series = _truflation_series_to_pd(truf, "seriesLevel")
    used_truf = bool(truf.get("ok") and not yoy_series.empty)

    X, y = _build_supervised(
        panel, daily_frame, clev, truf, yoy_series, level_series,
        as_of_day=as_of_day,
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
        tfeats = _truflation_features_for_month(
            truf, target_month_end, as_of_day, yoy_series, level_series,
        )
        tfeats = _truf_yoy_minus_lag(tfeats, panel, target_month_end)
        feats.update(tfeats)
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
    return TruflationNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_clev,
        used_truflation_scrape=used_truf,
    )
