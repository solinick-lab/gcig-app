"""Passive-Aggressive Regressor nowcaster (online-learning style).

Hypothesis: Passive-Aggressive (PA) updates are designed for streaming /
online regression where the model only changes when its prediction
violates an epsilon margin around the new label. With C=0.1 (mild
aggressiveness) and epsilon=0.1 (only update when |y - y_hat| > 0.1
MoM bps), the regressor effectively passes through "easy" months and
adapts hard on regime breaks. Because each cut runs `partial_fit` over
the supervised history in chronological order, recent shocks dominate
the final weight vector — a built-in form of online forgetting.

Approach (per backtest cut):
  1. Build the same Yellen 1.1 (clev_calibrated) supervised feature
     matrix: quantile_rich + Cleveland nowcast features + CPI lags +
     seasonal sin/cos.
  2. StandardScaler on the training matrix.
  3. PassiveAggressiveRegressor(C=0.1, epsilon=0.1) fitted via
     `partial_fit` chronologically — emulates a streaming consumer
     seeing one CPI release per month.
  4. Single point prediction for the target month. 80% bands = pred +/-
     z80 * recent residual std (no posterior available from PA), with
     a YoY-space floor.

Public API mirrors clev_calibrated:
  backtest_passive_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_passive_nowcast(as_of_day=20) -> PassiveNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.linear_model import PassiveAggressiveRegressor
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import _clev_features_for_month, _safe_get_clev
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05
_Z80 = 1.2816  # one-sided z for 80% interval
_STD_FLOOR = 0.10

# Tunables required by spec
_PA_C = 0.1
_PA_EPSILON = 0.1
_PA_MAX_ITER = 200
_PA_RANDOM_STATE = 42

# Number of chronological passes via partial_fit. Multiple passes let
# the PA regressor settle into a reasonable weight vector while still
# being recency-biased (last passes see the most recent rows last).
_PA_PASSES = 5

# Tail length for empirical residual std used to build the 80% band.
_RESID_TAIL = 18


@dataclass
class PassiveNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Supervised dataset (same Yellen 1.1 / clev_calibrated feature surface)
# ---------------------------------------------------------------------------


def _build_supervised(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """quantile_rich features + CPI lags + Cleveland nowcast features."""
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
# PA fit via streaming partial_fit
# ---------------------------------------------------------------------------


def _fit_pa(
    X: np.ndarray, y: np.ndarray,
) -> tuple[PassiveAggressiveRegressor, StandardScaler]:
    """Fit PassiveAggressiveRegressor by streaming rows in chronological
    order via partial_fit. Multiple passes (`_PA_PASSES`) let the model
    settle while still being recency-biased on the final pass.
    """
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)

    pa = PassiveAggressiveRegressor(
        C=_PA_C,
        epsilon=_PA_EPSILON,
        max_iter=_PA_MAX_ITER,
        random_state=_PA_RANDOM_STATE,
        warm_start=True,
        tol=None,  # let max_iter / partial_fit drive convergence
    )

    n = len(y)
    if n == 0:
        return pa, scaler

    for _ in range(_PA_PASSES):
        for i in range(n):
            xi = Xs[i:i + 1]
            yi = np.asarray([y[i]], dtype=float)
            try:
                pa.partial_fit(xi, yi)
            except Exception:
                continue
    return pa, scaler


def _empirical_resid_std(
    pa: PassiveAggressiveRegressor,
    scaler: StandardScaler,
    X: np.ndarray,
    y: np.ndarray,
) -> float:
    """Std of in-sample residuals on the last `_RESID_TAIL` rows.

    PA has no native uncertainty so we reuse the recent residual scale
    as a proxy for the conditional spread. Floored at `_STD_FLOOR`.
    """
    if len(y) == 0:
        return _STD_FLOOR
    try:
        Xs = scaler.transform(X)
        yhat = pa.predict(Xs)
        resid = y - yhat
        tail = resid[-_RESID_TAIL:] if len(resid) > _RESID_TAIL else resid
        if len(tail) < 2:
            return _STD_FLOOR
        return max(float(np.std(tail, ddof=1)), _STD_FLOOR)
    except Exception:
        return _STD_FLOOR


def _predict_with_band(
    pa: PassiveAggressiveRegressor,
    scaler: StandardScaler,
    x_inf: np.ndarray,
    resid_std: float,
) -> tuple[float, float, float]:
    x_s = scaler.transform(x_inf.reshape(1, -1))
    mid = float(pa.predict(x_s)[0])
    spread = _Z80 * resid_std
    return mid, mid - spread, mid + spread


# ---------------------------------------------------------------------------
# YoY conversion (mirrors nowcast_clev / nowcast_online)
# ---------------------------------------------------------------------------


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


def backtest_passive_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using PassiveAggressiveRegressor (online style)."""
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

            X, y = _build_supervised(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            cols = list(X.columns)
            X_arr = X.values.astype(float)
            y_arr = y.values.astype(float)
            pa, scaler = _fit_pa(X_arr, y_arr)
            resid_std = _empirical_resid_std(pa, scaler, X_arr, y_arr)

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
            x_inf_arr = x_inf.values.astype(float)

            mid, lo, hi = _predict_with_band(pa, scaler, x_inf_arr, resid_std)
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
        "paC": _PA_C,
        "paEpsilon": _PA_EPSILON,
        "paPasses": _PA_PASSES,
        "rows": rows,
    }


def run_passive_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> PassiveNowcastResult:
    """Live nowcast using PassiveAggressiveRegressor on Yellen 1.1 features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised(panel, daily_frame, clev, as_of_day=as_of_day)
    cols = list(X.columns)
    X_arr = X.values.astype(float)
    y_arr = y.values.astype(float)
    pa, scaler = _fit_pa(X_arr, y_arr)
    resid_std = _empirical_resid_std(pa, scaler, X_arr, y_arr)

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
    x_inf_arr = x_inf.values.astype(float)
    mid, lo, hi = _predict_with_band(pa, scaler, x_inf_arr, resid_std)
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
    return PassiveNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
