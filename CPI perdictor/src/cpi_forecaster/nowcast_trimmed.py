"""Trimmed-mean-targeted CPI Nowcast.

Strategy: trimmed-mean CPI (TRMMEANCPIM158SFRBCLE) drops the most extreme
price changes each month — by construction it has a much higher
signal-to-noise ratio than headline. Models that fit headline directly
spend half their capacity chasing month-specific shocks (energy, used
cars, airfares); models fit to the trimmed series learn the underlying
trend.

We exploit this by:
  1. Forecasting the TRIMMED-mean MoM directly with the same
     quantile_rich + Cleveland-Fed feature stack used in nowcast_clev.
  2. Converting the trimmed forecast to a trimmed YoY.
  3. Adding the trailing 6-month mean of the YoY-space wedge
        wedge[t] = headline_yoy[t] - trimmed_yoy[t]
     to recover a headline YoY estimate.

Why YoY-space wedge (vs MoM space, as in the failed `agent_uu_trimtarget`
attempt)? Adding the MoM wedge each month makes the YoY conversion sum
twelve noisy MoM-wedge errors. The YoY wedge is much smoother (12-month
averaging is baked in), and we average IT over a further 6 months —
yielding a near-stationary level adjustment. That's the variance that
the wedge introduces; it's small relative to the noise saved by
predicting trimmed-mean instead of headline directly.

Public API mirrors `nowcast_clev`:
  backtest_trimmed_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_trimmed_nowcast(as_of_day=20) -> TrimmedNowcastResult
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
from .nowcast_clev import _clev_features_for_month, _safe_get_clev


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05
_WEDGE_WINDOW = 6  # months for trailing wedge mean
_TRIMMED_ID = "TRMMEANCPIM158SFRBCLE"

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class TrimmedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float           # implied headline MoM (back-solved from YoY)
    pred_yoy: float           # final headline YoY (trimmed YoY + wedge)
    trimmed_pred_yoy: float   # raw trimmed YoY before wedge
    wedge_recent: float       # trailing 6-month mean of (headline_yoy - trimmed_yoy)
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Trimmed-MoM target builder
# ---------------------------------------------------------------------------


def _trimmed_mom(panel: pd.DataFrame) -> pd.Series:
    """Return MoM log-% of trimmed-mean CPI level. Empty if column missing."""
    if _TRIMMED_ID not in panel.columns:
        return pd.Series(dtype=float)
    s = panel[_TRIMMED_ID].astype(float).dropna()
    if len(s) < 13:
        return pd.Series(dtype=float)
    mom = (np.log(s) - np.log(s.shift(1))) * 100.0
    return mom.dropna()


def _trimmed_yoy(panel: pd.DataFrame) -> pd.Series:
    """Return YoY % of trimmed-mean CPI level. Empty if column missing."""
    if _TRIMMED_ID not in panel.columns:
        return pd.Series(dtype=float)
    s = panel[_TRIMMED_ID].astype(float).dropna()
    if len(s) < 13:
        return pd.Series(dtype=float)
    yoy = (s / s.shift(12) - 1.0) * 100.0
    return yoy.dropna()


def _headline_yoy(panel: pd.DataFrame) -> pd.Series:
    """Return headline CPI YoY %."""
    s = panel[TARGET.fred_id].astype(float).dropna()
    if len(s) < 13:
        return pd.Series(dtype=float)
    yoy = (s / s.shift(12) - 1.0) * 100.0
    return yoy.dropna()


def _wedge_at(
    panel: pd.DataFrame,
    cut_month_end: pd.Timestamp,
    window: int = _WEDGE_WINDOW,
) -> float:
    """Trailing `window`-month mean of (headline_yoy - trimmed_yoy) using ONLY
    data with index strictly less than cut_month_end. Returns 0.0 if the
    trimmed column is missing or there's not enough overlapping history.
    """
    try:
        h_yoy = _headline_yoy(panel)
        t_yoy = _trimmed_yoy(panel)
        if h_yoy.empty or t_yoy.empty:
            return 0.0
        diff = (h_yoy - t_yoy).dropna()
        diff = diff.loc[diff.index < cut_month_end]
        if diff.empty:
            return 0.0
        tail = diff.tail(window)
        v = float(tail.mean())
        if not np.isfinite(v):
            return 0.0
        return v
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Supervised dataset (target = trimmed_mom)
# ---------------------------------------------------------------------------


def _build_supervised_trimmed(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Same feature stack as nowcast_clev but the target is TRIMMED MoM."""
    cpi = panel[TARGET.fred_id].dropna()
    headline_mom = build_target(panel).dropna()  # headline MoM (log %), used for lag features
    trim_mom = _trimmed_mom(panel)
    if trim_mom.empty:
        return pd.DataFrame(), pd.Series(dtype=float)

    # Eligible months — must have a trimmed_mom value AND enough history.
    eligible_months = trim_mom.index[min_history_months:] if len(trim_mom) > min_history_months else trim_mom.index

    rows: list[dict] = []
    targets: list[float] = []

    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        # Headline-CPI lag features (these are exogenous to the trimmed
        # series; the model can use them to learn the relationship).
        try:
            hlag = headline_mom.loc[:month_end]
            feats["cpi_mom_lag1"] = float(hlag.iloc[-2]) if len(hlag) >= 2 else np.nan
            feats["cpi_mom_lag2"] = float(hlag.iloc[-3]) if len(hlag) >= 3 else np.nan
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
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

        # Trimmed-CPI lag features — own AR(2) history of the target series.
        try:
            tlag = trim_mom.loc[:month_end]
            feats["trim_mom_lag1"] = float(tlag.iloc[-2]) if len(tlag) >= 2 else np.nan
            feats["trim_mom_lag2"] = float(tlag.iloc[-3]) if len(tlag) >= 3 else np.nan
            # 6-month mean MoM of trimmed (anchor)
            if len(tlag) >= 7:
                feats["trim_mom_6m_mean"] = float(tlag.iloc[-7:-1].mean())
            else:
                feats["trim_mom_6m_mean"] = np.nan
        except Exception:
            feats["trim_mom_lag1"] = np.nan
            feats["trim_mom_lag2"] = np.nan
            feats["trim_mom_6m_mean"] = np.nan

        # Trimmed YoY lag (smoothed signal)
        try:
            tyoy = _trimmed_yoy(panel).loc[:month_end]
            feats["trim_yoy_lag1"] = float(tyoy.iloc[-2]) if len(tyoy) >= 2 else np.nan
        except Exception:
            feats["trim_yoy_lag1"] = np.nan

        # Seasonality
        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))

        # Cleveland nowcast features (computed for the headline target month;
        # they're informative for trimmed MoM as well — both are inflation).
        try:
            feats.update(_clev_features_for_month(clev, month_end, panel))
        except Exception:
            pass

        feats["target_month_end"] = month_end
        rows.append(feats)
        try:
            targets.append(float(trim_mom.loc[month_end]))
        except Exception:
            rows.pop()
            continue

    if not rows:
        return pd.DataFrame(), pd.Series(dtype=float)

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_trim_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------------
# Fit / predict
# ---------------------------------------------------------------------------


def _fit_quantile_models(X: pd.DataFrame, y: pd.Series) -> dict:
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


def _trimmed_mom_to_yoy(
    pred_trim_mom: float,
    panel: pd.DataFrame,
    target_month_end: pd.Timestamp,
) -> float:
    """Convert a predicted trimmed MoM (log %) into a trimmed YoY %.

    Uses the trimmed-mean level series in `panel`. We need:
      - last available trimmed level strictly before target_month_end
      - the trimmed level 12 months before target_month_end (denom for YoY)
    """
    try:
        s = panel[_TRIMMED_ID].astype(float).dropna()
    except Exception:
        return float("nan")
    s_prior = s.loc[s.index < target_month_end]
    if s_prior.empty:
        return float("nan")
    last_level = float(s_prior.iloc[-1])
    pred_level = last_level * float(np.exp(pred_trim_mom / 100.0))

    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(s.loc[denom_idx])
    except KeyError:
        try:
            denom = float(s.asof(denom_idx))
        except Exception:
            return float("nan")
    if not np.isfinite(denom) or denom == 0.0:
        return float("nan")
    return (pred_level / denom - 1.0) * 100.0


def _yoy_to_implied_headline_mom(
    pred_headline_yoy: float,
    panel: pd.DataFrame,
    target_month_end: pd.Timestamp,
) -> float:
    """Back-solve the headline MoM (log %) implied by a headline YoY forecast,
    given last released headline CPI (strictly before target_month_end).
    """
    try:
        cpi = panel[TARGET.fred_id].astype(float).dropna()
    except Exception:
        return float("nan")
    cpi_prior = cpi.loc[cpi.index < target_month_end]
    if cpi_prior.empty:
        return float("nan")
    last_cpi = float(cpi_prior.iloc[-1])
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        try:
            denom = float(cpi.asof(denom_idx))
        except Exception:
            return float("nan")
    if not np.isfinite(denom) or denom == 0.0 or last_cpi == 0.0:
        return float("nan")
    pred_level = denom * (1.0 + pred_headline_yoy / 100.0)
    if pred_level <= 0:
        return float("nan")
    return float(np.log(pred_level / last_cpi) * 100.0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_trimmed_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest. Predicts trimmed MoM, converts to trimmed YoY,
    adds the trailing 6-month YoY-wedge to recover headline YoY.
    """
    try:
        cpi = panel[TARGET.fred_id].dropna()
    except Exception:
        return {"error": "missing CPI target"}

    if _TRIMMED_ID not in panel.columns:
        return {"error": "trimmed-mean CPI column missing from panel"}

    trim_mom_full = _trimmed_mom(panel)
    if trim_mom_full.empty:
        return {"error": "trimmed-mean CPI has insufficient history"}

    headline_mom_full = build_target(panel).dropna()
    # Pick cuts on the headline MoM index so backtest aligns with prior nowcasters.
    # But ONLY months where we ALSO have a trimmed_mom value (so we can score the
    # trimmed prediction itself in diagnostics).
    common_idx = headline_mom_full.index.intersection(trim_mom_full.index)
    if len(common_idx) < window_months + 36:
        # Not strictly fatal — just take the tail we have.
        pass

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    # Use headline_mom_full for the cut grid (consistent w/ other backtests).
    cuts = list(range(len(headline_mom_full) - window_months, len(headline_mom_full)))

    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    preds_mom_implied: list[float] = []
    actuals_mom: list[float] = []
    trimmed_preds_yoy: list[float] = []
    trimmed_actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = headline_mom_full.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue
            if _TRIMMED_ID not in train_panel.columns:
                continue
            # Need trimmed history in the train cut.
            trim_train = _trimmed_mom(train_panel)
            if trim_train.empty or len(trim_train) < 36:
                continue

            X, y = _build_supervised_trimmed(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # Inference features at the as-of date for THIS target month.
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)

            # Headline lag features
            train_y_head = build_target(train_panel).dropna()
            if len(train_y_head) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y_head.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y_head.iloc[-2]) if len(train_y_head) >= 2 else np.nan
            try:
                cpi_train = train_panel[TARGET.fred_id].dropna()
                feats["cpi_yoy_lag1"] = float(
                    (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
                )
            except Exception:
                feats["cpi_yoy_lag1"] = np.nan

            # Trimmed lag features
            feats["trim_mom_lag1"] = float(trim_train.iloc[-1])
            feats["trim_mom_lag2"] = float(trim_train.iloc[-2]) if len(trim_train) >= 2 else np.nan
            feats["trim_mom_6m_mean"] = (
                float(trim_train.iloc[-6:].mean()) if len(trim_train) >= 6 else np.nan
            )
            try:
                tyoy_train = _trimmed_yoy(train_panel)
                feats["trim_yoy_lag1"] = (
                    float(tyoy_train.iloc[-1]) if len(tyoy_train) >= 1 else np.nan
                )
            except Exception:
                feats["trim_yoy_lag1"] = np.nan

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
            lo = float(np.clip(lo, _MOM_LO_CLIP, _MOM_HI_CLIP))
            hi = float(np.clip(hi, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # Trimmed MoM -> Trimmed YoY (use full panel for the YoY denom,
            # which is 12 months prior — that's a real released value).
            trimmed_pred_yoy = _trimmed_mom_to_yoy(mid, panel, target_month_end)
            trimmed_pred_yoy_lo = _trimmed_mom_to_yoy(lo, panel, target_month_end)
            trimmed_pred_yoy_hi = _trimmed_mom_to_yoy(hi, panel, target_month_end)

            if not np.isfinite(trimmed_pred_yoy):
                continue

            # Wedge from training cut (uses ONLY data strictly before target).
            wedge = _wedge_at(train_panel, target_month_end, window=_WEDGE_WINDOW)

            pred_yoy = trimmed_pred_yoy + wedge
            pred_lo_yoy = trimmed_pred_yoy_lo + wedge
            pred_hi_yoy = trimmed_pred_yoy_hi + wedge

            # Actuals
            actual_mom = float(headline_mom_full.iloc[ci])
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            # Diagnostic: trimmed actual YoY (if available)
            actual_trim_yoy = float("nan")
            try:
                tyoy_full = _trimmed_yoy(panel)
                if target_month_end in tyoy_full.index:
                    actual_trim_yoy = float(tyoy_full.loc[target_month_end])
            except Exception:
                pass

            implied_mom = _yoy_to_implied_headline_mom(pred_yoy, panel, target_month_end)
            if np.isfinite(implied_mom):
                implied_mom = float(np.clip(implied_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            if np.isfinite(implied_mom):
                preds_mom_implied.append(implied_mom)
                actuals_mom.append(actual_mom)
            trimmed_preds_yoy.append(trimmed_pred_yoy)
            if np.isfinite(actual_trim_yoy):
                trimmed_actuals_yoy.append(actual_trim_yoy)

            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_trim_mom": round(mid, 4),
                "pred_trim_yoy": round(trimmed_pred_yoy, 3),
                "wedge": round(wedge, 3),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "actual_trim_yoy": round(actual_trim_yoy, 3) if np.isfinite(actual_trim_yoy) else None,
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "lo80_yoy": round(pred_lo_yoy, 3),
                "hi80_yoy": round(pred_hi_yoy, 3),
            })
        except Exception:
            continue

    if not preds_yoy:
        return {"error": "no successful cuts"}

    py = np.array(preds_yoy); ay = np.array(actuals_yoy)
    yoy_err = np.abs(py - ay)

    out: dict = {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_yoy),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "usedClevScrape": used_scrape,
        "wedgeWindow": _WEDGE_WINDOW,
        "rows": rows,
    }
    if preds_mom_implied:
        pm = np.array(preds_mom_implied); am = np.array(actuals_mom)
        out["rmseMomImplied"] = float(np.sqrt(np.mean((pm - am) ** 2)))
    if trimmed_preds_yoy and trimmed_actuals_yoy and len(trimmed_preds_yoy) == len(trimmed_actuals_yoy):
        ty = np.array(trimmed_preds_yoy); tay = np.array(trimmed_actuals_yoy)
        out["rmseTrimmedYoy"] = float(np.sqrt(np.mean((ty - tay) ** 2)))
    return out


def run_trimmed_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> TrimmedNowcastResult:
    """Live nowcast. Wraps everything; degrades gracefully if trimmed series
    isn't in the panel by falling back to a YoY persistence print.
    """
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

    # Fallback path: trimmed series unavailable -> persist last YoY.
    if _TRIMMED_ID not in panel.columns or _trimmed_mom(panel).empty:
        last_yoy = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0) if len(cpi) >= 13 else 0.0
        return TrimmedNowcastResult(
            as_of=as_of,
            target_month=target_month_end.strftime("%Y-%m"),
            pred_mom=0.0,
            pred_yoy=last_yoy,
            trimmed_pred_yoy=last_yoy,
            wedge_recent=0.0,
            lo80_yoy=last_yoy - _RESID_FLOOR,
            hi80_yoy=last_yoy + _RESID_FLOOR,
            days_observed=0,
            used_clev_scrape=used_scrape,
        )

    X, y = _build_supervised_trimmed(panel, daily_frame, clev, as_of_day=as_of_day)
    if len(X) < 24:
        last_yoy = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0) if len(cpi) >= 13 else 0.0
        return TrimmedNowcastResult(
            as_of=as_of,
            target_month=target_month_end.strftime("%Y-%m"),
            pred_mom=0.0,
            pred_yoy=last_yoy,
            trimmed_pred_yoy=last_yoy,
            wedge_recent=0.0,
            lo80_yoy=last_yoy - _RESID_FLOOR,
            hi80_yoy=last_yoy + _RESID_FLOOR,
            days_observed=0,
            used_clev_scrape=used_scrape,
        )

    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    feats = rich_features_at(daily_frame, as_of)

    headline_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(headline_mom.iloc[-1]) if len(headline_mom) else np.nan
    feats["cpi_mom_lag2"] = float(headline_mom.iloc[-2]) if len(headline_mom) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = (
        float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0) if len(cpi) >= 13 else np.nan
    )

    trim_mom_series = _trimmed_mom(panel)
    feats["trim_mom_lag1"] = float(trim_mom_series.iloc[-1]) if len(trim_mom_series) else np.nan
    feats["trim_mom_lag2"] = float(trim_mom_series.iloc[-2]) if len(trim_mom_series) >= 2 else np.nan
    feats["trim_mom_6m_mean"] = (
        float(trim_mom_series.iloc[-6:].mean()) if len(trim_mom_series) >= 6 else np.nan
    )
    tyoy_series = _trimmed_yoy(panel)
    feats["trim_yoy_lag1"] = float(tyoy_series.iloc[-1]) if len(tyoy_series) else np.nan

    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
    mid, lo, hi = _predict_triple(models, x_inf, cols)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
    lo = float(np.clip(lo, _MOM_LO_CLIP, _MOM_HI_CLIP))
    hi = float(np.clip(hi, _MOM_LO_CLIP, _MOM_HI_CLIP))

    trimmed_pred_yoy = _trimmed_mom_to_yoy(mid, panel, target_month_end)
    trimmed_lo_yoy = _trimmed_mom_to_yoy(lo, panel, target_month_end)
    trimmed_hi_yoy = _trimmed_mom_to_yoy(hi, panel, target_month_end)

    wedge = _wedge_at(panel, target_month_end, window=_WEDGE_WINDOW)
    pred_yoy = trimmed_pred_yoy + wedge if np.isfinite(trimmed_pred_yoy) else float("nan")
    lo80_yoy = trimmed_lo_yoy + wedge if np.isfinite(trimmed_lo_yoy) else float("nan")
    hi80_yoy = trimmed_hi_yoy + wedge if np.isfinite(trimmed_hi_yoy) else float("nan")

    if np.isfinite(pred_yoy) and np.isfinite(hi80_yoy) and (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if np.isfinite(pred_yoy) and np.isfinite(lo80_yoy) and (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    implied_head_mom = _yoy_to_implied_headline_mom(pred_yoy, panel, target_month_end) if np.isfinite(pred_yoy) else float("nan")
    if np.isfinite(implied_head_mom):
        implied_head_mom = float(np.clip(implied_head_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
    else:
        implied_head_mom = 0.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return TrimmedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=implied_head_mom,
        pred_yoy=float(pred_yoy) if np.isfinite(pred_yoy) else 0.0,
        trimmed_pred_yoy=float(trimmed_pred_yoy) if np.isfinite(trimmed_pred_yoy) else 0.0,
        wedge_recent=float(wedge),
        lo80_yoy=float(lo80_yoy) if np.isfinite(lo80_yoy) else 0.0,
        hi80_yoy=float(hi80_yoy) if np.isfinite(hi80_yoy) else 0.0,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
