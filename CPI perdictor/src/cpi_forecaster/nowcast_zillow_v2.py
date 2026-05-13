"""Zillow nowcaster v2 — wider lag search + derived momentum features.

Hypothesis (v2): the original `nowcast_zillow.py` exposed only ZORI
lags 0/6/12 of YoY. Shelter inflation transmission to BLS OER and rent
CPI is well-documented to be 12-18 months — sometimes longer in the
post-pandemic regime. Lag-12 alone may either be too short OR too long
depending on the regime.

What's new vs v1:
  1. Wider lag set on YoY: 1, 3, 6, 9, 12, 15, 18, 21, 24 months. Lets
     the GBR pick the lag that actually matters in a given regime
     instead of forcing a hand-picked 0/6/12.
  2. Derived signals:
       - `zori_yoy_ma6`        : 6-month moving average of YoY (smoothed
         momentum that a noisy single-month YoY can't see).
       - `zori_yoy_accel`      : YoY at lag 12 minus YoY at lag 24 (is
         the rent regime accelerating or decelerating?).
       - `zori_3m_momentum_lag12` : compounded MoM over months
         lag10..lag12 (a 3-month trend already 12 months back, the part
         of ZORI that BLS shelter is actively "catching up to").
  3. We keep the FULL clev_nowcast feature set (rich + Cleveland Fed
     historical archive). v2 is strictly an additive lag/feature
     experiment over the same backbone.

Public API:
  backtest_zillow_v2_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_zillow_v2_nowcast(as_of_day=20) -> ZillowV2NowcastResult

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import _clev_features_for_month, _safe_get_clev
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_zillow import _safe_get_zillow, _zillow_history_to_series


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

# Wider lag search: instead of 0/6/12, try every 3 months out to 2 years.
# The GBR can pick which lags actually matter for the current regime.
_YOY_LAGS = (1, 3, 6, 9, 12, 15, 18, 21, 24)


@dataclass
class ZillowV2NowcastResult:
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
# Zillow v2 feature builder
# ---------------------------------------------------------------------------


def _zillow_v2_features_for_month(
    zori_df: pd.DataFrame | None,
    target_month_end: pd.Timestamp,
    is_scrape: bool,
) -> dict[str, float]:
    """Build expanded Zillow ZORI features for one target month.

    Only uses Zillow data strictly before `target_month_end` (Zillow's
    publication lag is typically a couple weeks to a month, so the
    cutoff is target_month_end - 1 month).

    Returns:
      zori_yoy_lag{k} for k in 1,3,6,9,12,15,18,21,24
      zori_mom_lag0   : most recent MoM
      zori_yoy_ma6    : 6-month MA of YoY (smoothed momentum)
      zori_yoy_accel  : YoY(lag12) - YoY(lag24) (regime acceleration)
      zori_3m_momentum_lag12 : 3-month compounded MoM around lag-12
      zori_used_scrape : 1 if real ZORI / 0 if fallback / missing
    """
    feats: dict[str, float] = {f"zori_yoy_lag{k}": np.nan for k in _YOY_LAGS}
    feats.update({
        "zori_mom_lag0": np.nan,
        "zori_yoy_ma6": np.nan,
        "zori_yoy_accel": np.nan,
        "zori_3m_momentum_lag12": np.nan,
        "zori_used_scrape": 1.0 if is_scrape else 0.0,
    })

    if zori_df is None or zori_df.empty:
        feats["zori_used_scrape"] = 0.0
        return feats

    # Only use Zillow data strictly before the target month.
    cutoff = target_month_end + pd.offsets.MonthEnd(-1)
    avail = zori_df.loc[zori_df.index <= cutoff]
    if avail.empty:
        return feats

    yoy = avail["yoy"].copy() if "yoy" in avail.columns else pd.Series(dtype=float)
    mom = avail["mom"].copy() if "mom" in avail.columns else pd.Series(dtype=float)

    # Most recent MoM (rent acceleration NOW)
    if not mom.empty:
        last_mom = mom.iloc[-1]
        if isinstance(last_mom, (int, float)) and np.isfinite(last_mom):
            feats["zori_mom_lag0"] = float(last_mom)

    # YoY at each lag — `lag1` means the last available month
    # (target_month_end - 1), `lagK` means K months back from there.
    n = len(yoy)
    for k in _YOY_LAGS:
        # lag1 = last row (index -1), lag2 = -2, ... lagK = -K
        idx = n - k
        if 0 <= idx < n:
            v = yoy.iloc[idx]
            if isinstance(v, (int, float)) and np.isfinite(v):
                feats[f"zori_yoy_lag{k}"] = float(v)

    # 6-month MA of YoY at the latest available month — smoothed momentum
    if n >= 6:
        recent6 = yoy.iloc[-6:].dropna()
        if len(recent6) >= 3:
            feats["zori_yoy_ma6"] = float(recent6.mean())

    # YoY acceleration: lag12 - lag24 (post-pandemic regime check)
    v12 = feats.get("zori_yoy_lag12", np.nan)
    v24 = feats.get("zori_yoy_lag24", np.nan)
    if np.isfinite(v12) and np.isfinite(v24):
        feats["zori_yoy_accel"] = float(v12 - v24)

    # 3-month momentum at lag-12: compound MoM at lag10/11/12 from the
    # most recent available point. This captures the trend in rents
    # exactly when the BLS shelter component is now catching up to.
    if not mom.empty and n >= 13:
        # mom positions for "lag 10/11/12" months back from the latest
        # available month — i.e. iloc[-12:-9] (3 months ending at lag12).
        block = mom.iloc[-12:-9].dropna()
        if len(block) >= 2:
            # Compound MoM percent into a 3-month momentum percent.
            try:
                ratio = np.prod(1.0 + block.values / 100.0)
                feats["zori_3m_momentum_lag12"] = float((ratio - 1.0) * 100.0)
            except Exception:
                feats["zori_3m_momentum_lag12"] = float(block.mean())

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_zillow_v2(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    zori_df: pd.DataFrame | None,
    is_zillow_scrape: bool,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich + Cleveland + expanded Zillow v2 features per month."""
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

        # CPI lag features (same as v1 / clev)
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

        # Zillow ZORI v2 features (wide lag set + derived momentum)
        try:
            feats.update(
                _zillow_v2_features_for_month(zori_df, month_end, is_zillow_scrape)
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


def backtest_zillow_v2_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest: quantile_rich + Cleveland + Zillow v2 features.

    Calls each scrape ONCE up-front (not per cut). Each cut wrapped in
    try/except so a single failure doesn't poison the whole window.
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

            X, y = _build_supervised_zillow_v2(
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
                    _zillow_v2_features_for_month(zori_df, target_month_end, used_zillow)
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


def run_zillow_v2_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> ZillowV2NowcastResult:
    """Live nowcast using fresh Cleveland + Zillow scrapes + v2 lag set."""
    try:
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

        X, y = _build_supervised_zillow_v2(
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
                _zillow_v2_features_for_month(zori_df, target_month_end, used_zillow)
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
        return ZillowV2NowcastResult(
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
    except Exception as exc:
        # Fail-soft: surface a sentinel result so the harness can tag
        # this as a failed run instead of crashing the whole pipeline.
        now = pd.Timestamp.utcnow().tz_localize(None).normalize()
        return ZillowV2NowcastResult(
            as_of=now,
            target_month="",
            pred_mom=float("nan"),
            pred_yoy=float("nan"),
            lo80_yoy=float("nan"),
            hi80_yoy=float("nan"),
            days_observed=0,
            used_clev_scrape=False,
            used_zillow_scrape=False,
            zillow_source=f"error: {exc}",
        )
