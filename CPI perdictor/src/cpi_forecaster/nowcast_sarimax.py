"""SARIMAX nowcaster — classical state-space model with exogenous regressors.

Why SARIMAX here? The Cleveland-Fed nowcast (`nowcast_clev.py`) is a strong
single-feature baseline; tree models layer non-linear interactions on top.
SARIMAX takes the orthogonal approach: model CPI MoM as a stochastic process
with seasonal differencing + AR/MA dynamics, and let exogenous regressors
(Cleveland nowcast, oil/gas momentum, breakevens, Michigan expectations)
shift the conditional mean. The seasonal MA(1)_12 term handles
"yearly-residual seasonality" that gradient boosters often leak through
their tree splits, and the (1,0,1) ARMA captures short-term shocks.

Architecture mirrors `nowcast_clev.py`:
  - One scrape of Cleveland nowcast up-front (historical archive covers
    every backtest cut).
  - Walk-forward backtest: at each cut t, train on data BEFORE t, predict t.
  - Exogenous matrix is reindexed to the CPI MoM series; missing values
    are forward-filled then median-imputed.

Order: (1,0,1)(0,1,1,12) — light AR/MA, seasonal differencing of order 1
with seasonal MA(1) at lag 12. Forecast 1 step. 80% bands from
`get_forecast(steps=1).conf_int(alpha=0.20)`.

SARIMAX often fails to converge on small/short panels — every fit and
forecast is wrapped. On any failure we fall back to predicting the LAST
observed MoM (a "last value" baseline).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

try:  # statsmodels is heavy; import inside try so module import never fails
    from statsmodels.tsa.statespace.sarimax import SARIMAX
except Exception:  # pragma: no cover - statsmodels missing/broken
    SARIMAX = None  # type: ignore[assignment]

from .api_client import get_daily_panel, get_cleveland_nowcast
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_clev import _safe_get_clev, _clev_features_for_month


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_ORDER = (1, 0, 1)
_SEASONAL_ORDER = (0, 1, 1, 12)
_ALPHA_80 = 0.20  # 80% prediction interval
_Z80 = 1.2816
_RESID_FLOOR = 0.05
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5

_OIL_ID = "DCOILWTICO"
_GAS_ID = "GASREGW"
_T5YIE_ID = "T5YIE"
_MICH_ID = "MICH"


@dataclass
class SarimaxNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_fallback: bool


# ---------------------------------------------------------------------------
# Exogenous matrix construction
# ---------------------------------------------------------------------------


def _series_pct_change_21d(s: pd.Series, as_of: pd.Timestamp) -> float:
    """Daily-series % change: average of last ~21 trading days vs the
    21 days before that. Mirrors a "21-day rolling momentum" signal.
    Returns NaN if either window is empty."""
    if s is None or len(s) == 0:
        return float("nan")
    end = as_of
    mid = end - pd.Timedelta(days=21)
    start = mid - pd.Timedelta(days=21)
    recent = s.loc[(s.index > mid) & (s.index <= end)]
    prior = s.loc[(s.index > start) & (s.index <= mid)]
    if len(recent) == 0 or len(prior) == 0:
        return float("nan")
    r = float(recent.mean())
    p = float(prior.mean())
    if not np.isfinite(r) or not np.isfinite(p) or p == 0:
        return float("nan")
    return (r / p - 1.0) * 100.0


def _exog_for_month(
    target_month_end: pd.Timestamp,
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
) -> dict[str, float]:
    """Build the exogenous regressor row for one target month.

    Features:
      clev_mom         — Cleveland Fed nowcast MoM for this target month
      oil_21d_pct      — WTI 21-day % change as of `as_of`
      gas_21d_pct      — Retail gas 21-day % change as of `as_of`
      t5yie            — 5Y TIPS breakeven (most recent reading <= as_of)
      mich             — Michigan 1Y inflation expectations (latest available
                         in monthly panel STRICTLY BEFORE target_month_end)
    """
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)

    # Cleveland MoM
    try:
        clev_feats = _clev_features_for_month(clev, target_month_end, panel)
        clev_mom = float(clev_feats.get("clev_mom", float("nan")))
    except Exception:
        clev_mom = float("nan")

    # Oil 21-day pct
    try:
        oil_pct = _series_pct_change_21d(daily_frame.get(_OIL_ID), as_of)
    except Exception:
        oil_pct = float("nan")

    # Gas 21-day pct (weekly series; treat the same way)
    try:
        gas_pct = _series_pct_change_21d(daily_frame.get(_GAS_ID), as_of)
    except Exception:
        gas_pct = float("nan")

    # T5YIE — daily series; latest reading at or before as_of
    t5yie = float("nan")
    try:
        s = daily_frame.get(_T5YIE_ID)
        if s is not None and len(s) > 0:
            recent = s.loc[s.index <= as_of]
            if len(recent) > 0:
                t5yie = float(recent.iloc[-1])
    except Exception:
        pass
    # Fallback: month-end value from the monthly panel (lag 1).
    if not np.isfinite(t5yie):
        try:
            if _T5YIE_ID in panel.columns:
                col = panel[_T5YIE_ID].dropna()
                prior = col.loc[col.index < target_month_end]
                if len(prior) > 0:
                    t5yie = float(prior.iloc[-1])
        except Exception:
            pass

    # MICH — monthly survey, lag 1 (last reading strictly before target month)
    mich = float("nan")
    try:
        if _MICH_ID in panel.columns:
            col = panel[_MICH_ID].dropna()
            prior = col.loc[col.index < target_month_end]
            if len(prior) > 0:
                mich = float(prior.iloc[-1])
    except Exception:
        pass

    return {
        "clev_mom": clev_mom,
        "oil_21d_pct": oil_pct,
        "gas_21d_pct": gas_pct,
        "t5yie": t5yie,
        "mich": mich,
    }


def _build_exog_matrix(
    months: pd.DatetimeIndex,
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
) -> pd.DataFrame:
    """Assemble the exogenous matrix indexed by month-end timestamps.

    Missing values are filled with column medians (and 0.0 if the whole
    column is NaN) — SARIMAX rejects NaN in `exog`.
    """
    rows: list[dict] = []
    for m in months:
        try:
            rows.append(_exog_for_month(m, panel, daily_frame, clev, as_of_day))
        except Exception:
            rows.append({
                "clev_mom": np.nan,
                "oil_21d_pct": np.nan,
                "gas_21d_pct": np.nan,
                "t5yie": np.nan,
                "mich": np.nan,
            })
    df = pd.DataFrame(rows, index=months)
    df.columns = ["clev_mom", "oil_21d_pct", "gas_21d_pct", "t5yie", "mich"]
    # Median-impute, then 0-fill remaining (entirely-NaN columns).
    med = df.median(numeric_only=True)
    df = df.fillna(med).fillna(0.0)
    return df


# ---------------------------------------------------------------------------
# Fit / predict
# ---------------------------------------------------------------------------


def _fit_and_forecast_sarimax(
    y: pd.Series,
    exog_train: pd.DataFrame,
    exog_forecast: pd.DataFrame,
) -> tuple[float, float, float, bool]:
    """Fit SARIMAX(1,0,1)(0,1,1,12) and forecast 1 step.

    Returns (mean, lo80, hi80, ok). On any failure returns
    (last_value, last_value-floor, last_value+floor, False) — caller
    handles fallback.
    """
    last_val = float(y.iloc[-1]) if len(y) > 0 else 0.0
    fallback = (last_val, last_val - _RESID_FLOOR, last_val + _RESID_FLOOR, False)

    if SARIMAX is None:
        return fallback
    if len(y) < 36:  # need at least a few seasonal cycles for D=1, s=12
        return fallback

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model = SARIMAX(
                y.values,
                exog=exog_train.values,
                order=_ORDER,
                seasonal_order=_SEASONAL_ORDER,
                enforce_stationarity=False,
                enforce_invertibility=False,
                trend=None,
            )
            res = model.fit(disp=False, maxiter=200, method="lbfgs")
    except Exception:
        return fallback

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fc = res.get_forecast(steps=1, exog=exog_forecast.values)
            mean = float(np.asarray(fc.predicted_mean).ravel()[0])
            ci = fc.conf_int(alpha=_ALPHA_80)
            ci_arr = np.asarray(ci)
            lo = float(ci_arr[0, 0])
            hi = float(ci_arr[0, 1])
    except Exception:
        return fallback

    # Sanity: any non-finite output -> fall back
    if not (np.isfinite(mean) and np.isfinite(lo) and np.isfinite(hi)):
        return fallback
    if hi < lo:
        lo, hi = hi, lo
    return mean, lo, hi, True


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


def backtest_sarimax_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the SARIMAX nowcaster.

    At each cut t, train SARIMAX on CPI MoM history strictly before t, with
    the exogenous matrix aligned to the same months. Predict t. Compare to
    actual. RMSE is reported on YoY %.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    if len(y_mom) < 60:
        return {"error": "insufficient history"}

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    fallback_count = 0
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_y = y_mom.iloc[:ci].copy()
            if len(train_y) < 36:
                continue
            train_panel = panel.loc[panel.index < target_month_end]

            # Build exogenous matrix for training months
            try:
                exog_train = _build_exog_matrix(
                    train_y.index, train_panel, daily_frame, clev, as_of_day,
                )
            except Exception:
                # If exog build fails wholesale, fall back per-cut
                last_mom = float(train_y.iloc[-1])
                last_cpi_train = float(cpi.loc[cpi.index < target_month_end].iloc[-1])
                pred_yoy = _mom_to_yoy(last_mom, last_cpi_train, target_month_end, cpi)
                actual_cpi = float(cpi.loc[target_month_end])
                denom_idx = target_month_end - pd.DateOffset(years=1)
                denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
                try:
                    denom = float(cpi.loc[denom_idx])
                except KeyError:
                    denom = float(cpi.asof(denom_idx))
                actual_yoy = (actual_cpi / denom - 1.0) * 100.0
                preds_mom.append(last_mom); actuals_mom.append(float(y_mom.iloc[ci]))
                preds_yoy.append(pred_yoy); actuals_yoy.append(actual_yoy)
                fallback_count += 1
                continue

            # Build forecast-row exog for the target month
            try:
                exog_fc_row = _exog_for_month(
                    target_month_end, train_panel, daily_frame, clev, as_of_day,
                )
                exog_forecast = pd.DataFrame([exog_fc_row], index=[target_month_end])
                exog_forecast = exog_forecast.reindex(columns=exog_train.columns)
                # Use train-medians for any missing values to keep the
                # distribution comparable to what the model saw at fit time.
                med = exog_train.median(numeric_only=True)
                exog_forecast = exog_forecast.fillna(med).fillna(0.0)
            except Exception:
                exog_forecast = pd.DataFrame(
                    [exog_train.median(numeric_only=True).to_dict()],
                    index=[target_month_end],
                ).fillna(0.0)

            mean_mom, lo_mom, hi_mom, ok = _fit_and_forecast_sarimax(
                train_y, exog_train, exog_forecast,
            )
            if not ok:
                fallback_count += 1

            mean_mom = float(np.clip(mean_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(cpi.loc[cpi.index < target_month_end].iloc[-1])
            pred_yoy = _mom_to_yoy(mean_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mean_mom); actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy); actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "pred_mom": round(mean_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "fallback": not ok,
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
        "fallbackCuts": fallback_count,
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_sarimax_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> SarimaxNowcastResult:
    """Live SARIMAX nowcast for the current target month.

    Wraps fitting aggressively — on convergence or any other failure we
    fall back to predicting the last observed MoM with a small interval.
    """
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()

    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # Build training exog over all observed CPI MoM months
    try:
        exog_train = _build_exog_matrix(
            y_mom.index, panel, daily_frame, clev, as_of_day,
        )
    except Exception:
        # Total fallback: last MoM
        last_mom = float(y_mom.iloc[-1])
        last_cpi = float(cpi.iloc[-1])
        pred_yoy = _mom_to_yoy(last_mom, last_cpi, target_month_end, cpi)
        return SarimaxNowcastResult(
            as_of=as_of,
            target_month=target_month_end.strftime("%Y-%m"),
            pred_mom=last_mom,
            pred_yoy=pred_yoy,
            lo80_yoy=pred_yoy - _RESID_FLOOR,
            hi80_yoy=pred_yoy + _RESID_FLOOR,
            days_observed=0,
            used_fallback=True,
        )

    # Forecast-row exog for the target month
    try:
        exog_fc_row = _exog_for_month(
            target_month_end, panel, daily_frame, clev, as_of_day,
        )
        exog_forecast = pd.DataFrame([exog_fc_row], index=[target_month_end])
        exog_forecast = exog_forecast.reindex(columns=exog_train.columns)
        med = exog_train.median(numeric_only=True)
        exog_forecast = exog_forecast.fillna(med).fillna(0.0)
    except Exception:
        exog_forecast = pd.DataFrame(
            [exog_train.median(numeric_only=True).to_dict()],
            index=[target_month_end],
        ).fillna(0.0)

    mean_mom, lo_mom, hi_mom, ok = _fit_and_forecast_sarimax(
        y_mom, exog_train, exog_forecast,
    )
    used_fallback = not ok
    mean_mom = float(np.clip(mean_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mean_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return SarimaxNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mean_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_fallback=used_fallback,
    )
