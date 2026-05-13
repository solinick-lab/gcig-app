"""ETS (exponential smoothing) nowcaster combined with Cleveland Fed (Yellen 1.1).

Hypothesis: Yellen 1.1 (clev_calibrated) is a strong ML model on rich daily
features + Cleveland Fed nowcast, but it can miss the slow-moving structural
trend that a classical state-space smoother captures naturally. Adding a
50/50 ensemble with a Holt-Winters ExponentialSmoothing fit on CPI MoM
gives a regularizing pull toward the long-run seasonal-trend-level path
that the ML model may underweight.

Approach (per cut):
  1. Run Yellen 1.1 (clev_calibrated) for the held-out month.
  2. Fit `statsmodels.tsa.holtwinters.ExponentialSmoothing` on the training
     window's CPI MoM (seasonal_periods=12, additive trend + additive
     seasonality), forecast 1 step ahead in MoM space.
  3. Convert the ETS MoM forecast to a YoY using the same _mom_to_yoy
     helper Yellen 1.1 uses (so both predictions live in the same space).
  4. Final pred = 0.5 * yellen_yoy + 0.5 * ets_yoy. Bands are shifted by
     the same delta so quantile widths from the base model are preserved.

Wrapping is aggressive: ExponentialSmoothing can fail to fit on short or
near-constant histories. ANY exception in the ETS path falls back to the
Yellen 1.1 prediction alone (effectively weight = 1.0 on Yellen).

Public API mirrors nowcast_clev_calibrated:
  backtest_ets_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_ets_nowcast(as_of_day=20) -> EtsNowcastResult

Every cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
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

_ENSEMBLE_W_YELLEN = 0.50    # weight on Yellen 1.1 (other 0.5 -> ETS)
_ETS_MIN_HISTORY = 36        # need ≥ 3 full seasonal cycles to even try ETS
_ETS_SEASONAL_PERIODS = 12   # CPI MoM is monthly, annual seasonality


# ---------------------------------------------------------------------------
# Result dataclass
# ---------------------------------------------------------------------------


@dataclass
class EtsNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    yellen_pred_yoy: float
    ets_pred_yoy: float
    ets_pred_mom: float
    ets_used: bool             # whether ETS actually contributed (vs. Yellen-only fallback)
    weight_yellen: float       # effective weight on Yellen (1.0 if ETS failed, else _ENSEMBLE_W_YELLEN)


# ---------------------------------------------------------------------------
# ETS helper — heavily wrapped, may return None
# ---------------------------------------------------------------------------


def _fit_ets_and_forecast_one_step(y_mom_train: pd.Series) -> float | None:
    """Fit Holt-Winters ExponentialSmoothing on training MoM series and
    forecast 1 step ahead. Returns the forecasted MoM (in pp) or None on
    any failure.

    Wrapping is intentionally aggressive: small/near-constant series, NaNs,
    convergence failures inside statsmodels, etc. all return None and the
    caller falls back to Yellen-only.
    """
    try:
        # Lazy import: statsmodels is in pyproject deps but a fresh dev
        # env may not have it; we never want an ImportError to break the
        # pipeline — fallback path handles that.
        from statsmodels.tsa.holtwinters import ExponentialSmoothing  # type: ignore
    except Exception:
        return None

    try:
        s = pd.Series(y_mom_train).dropna()
        if len(s) < _ETS_MIN_HISTORY:
            return None
        # Reset to a contiguous monthly index so statsmodels seasonal
        # decomposition is happy. (Original index is month-end timestamps;
        # we just need order + spacing for seasonal_periods=12.)
        s = s.astype(float)
        if not np.all(np.isfinite(s.values)):
            return None
        # Need some variation; constant series will explode the optimizer.
        if float(np.nanstd(s.values)) < 1e-6:
            return None

        # Try additive trend + additive seasonality first (CPI MoM is
        # roughly bounded and seasonal in pp). Wrap fit in try/except.
        try:
            model = ExponentialSmoothing(
                s.values,
                trend="add",
                seasonal="add",
                seasonal_periods=_ETS_SEASONAL_PERIODS,
                initialization_method="estimated",
            )
            fit = model.fit(optimized=True, use_brute=False)
            yhat = float(fit.forecast(1)[0])
        except Exception:
            # Retry with no trend (some short series fail to estimate trend)
            try:
                model = ExponentialSmoothing(
                    s.values,
                    trend=None,
                    seasonal="add",
                    seasonal_periods=_ETS_SEASONAL_PERIODS,
                    initialization_method="estimated",
                )
                fit = model.fit(optimized=True, use_brute=False)
                yhat = float(fit.forecast(1)[0])
            except Exception:
                return None

        if not np.isfinite(yhat):
            return None
        # Clip to the same MoM space the rest of the system uses.
        yhat = float(np.clip(yhat, _MOM_LO_CLIP, _MOM_HI_CLIP))
        return yhat
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Internal: produce a Yellen 1.1 (clev_calibrated) prediction for a cut
# ---------------------------------------------------------------------------


def _yellen_predict_for_cut(
    panel: pd.DataFrame,
    daily_frame: dict,
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> dict | None:
    """Run Yellen 1.1 on data strictly before target_month_end. Returns dict
    with yellen_yoy, mid_cal_mom, lo_cal_mom, hi_cal_mom, last_cpi_train,
    as_of, train_y_mom — or None on any failure.
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

        train_y_mom = build_target(train_panel).dropna()
        F_cal, t_cal = _build_calibration_dataset(
            X, y, models, cols, train_panel, train_y_mom
        )
        ridge = _fit_calibrator(F_cal, t_cal)

        # --- Inference features (matches Yellen 1.1) ---
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
        yellen_lo80 = _mom_to_yoy(lo_cal, last_cpi_train, target_month_end, cpi_full)
        yellen_hi80 = _mom_to_yoy(hi_cal, last_cpi_train, target_month_end, cpi_full)

        return {
            "yellen_yoy": yellen_yoy,
            "yellen_lo80": yellen_lo80,
            "yellen_hi80": yellen_hi80,
            "mid_cal_mom": mid_cal,
            "lo_cal_mom": lo_cal,
            "hi_cal_mom": hi_cal,
            "last_cpi_train": last_cpi_train,
            "as_of": as_of,
            "train_y_mom": train_y_mom,
        }
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Ensemble helper
# ---------------------------------------------------------------------------


def _ensemble_yellen_ets(
    yellen_yoy: float,
    yellen_lo80: float,
    yellen_hi80: float,
    yellen_mom: float,
    ets_mom: float | None,
    last_cpi_train: float,
    target_month_end: pd.Timestamp,
    cpi_full: pd.Series,
) -> tuple[float, float, float, float, float, bool, float]:
    """Combine Yellen 1.1 with the ETS forecast 50/50.

    If ets_mom is None (ETS failed), we fall back to Yellen-only output
    (weight=1.0 on Yellen). Bands shift by the same YoY delta as the mid
    so the base model's quantile width is preserved.

    Returns
    -------
    (final_mom, final_yoy, lo80_yoy, hi80_yoy, ets_yoy, ets_used, weight_yellen)
    """
    if ets_mom is None or not np.isfinite(ets_mom):
        return (
            float(yellen_mom),
            float(yellen_yoy),
            float(yellen_lo80),
            float(yellen_hi80),
            float("nan"),
            False,
            1.0,
        )

    try:
        ets_yoy = _mom_to_yoy(float(ets_mom), float(last_cpi_train), target_month_end, cpi_full)
    except Exception:
        return (
            float(yellen_mom),
            float(yellen_yoy),
            float(yellen_lo80),
            float(yellen_hi80),
            float("nan"),
            False,
            1.0,
        )

    if not np.isfinite(ets_yoy):
        return (
            float(yellen_mom),
            float(yellen_yoy),
            float(yellen_lo80),
            float(yellen_hi80),
            float("nan"),
            False,
            1.0,
        )

    w = float(_ENSEMBLE_W_YELLEN)
    final_mom = w * float(yellen_mom) + (1.0 - w) * float(ets_mom)
    final_mom = float(np.clip(final_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
    final_yoy = w * float(yellen_yoy) + (1.0 - w) * float(ets_yoy)

    yoy_shift = final_yoy - float(yellen_yoy)
    lo80_yoy = float(yellen_lo80) + yoy_shift
    hi80_yoy = float(yellen_hi80) + yoy_shift
    return final_mom, final_yoy, lo80_yoy, hi80_yoy, float(ets_yoy), True, w


# ---------------------------------------------------------------------------
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_ets_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of (Yellen 1.1) ⊕ (ETS) — 50/50 ensemble in
    YoY space, with Yellen-only fallback whenever ETS fails to fit.
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
    n_ets_used = 0

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            res = _yellen_predict_for_cut(panel, daily_frame, clev, target_month_end, as_of_day)
            if res is None:
                continue

            # ETS on the training MoM series strictly before target month
            ets_mom: float | None = None
            try:
                train_mom = res["train_y_mom"]
                ets_mom = _fit_ets_and_forecast_one_step(train_mom)
            except Exception:
                ets_mom = None

            (
                final_mom,
                final_yoy,
                lo80_yoy,
                hi80_yoy,
                ets_yoy,
                ets_used,
                w_yellen,
            ) = _ensemble_yellen_ets(
                yellen_yoy=res["yellen_yoy"],
                yellen_lo80=res["yellen_lo80"],
                yellen_hi80=res["yellen_hi80"],
                yellen_mom=res["mid_cal_mom"],
                ets_mom=ets_mom,
                last_cpi_train=res["last_cpi_train"],
                target_month_end=target_month_end,
                cpi_full=cpi,
            )
            if ets_used:
                n_ets_used += 1

            actual_mom = float(y_mom.iloc[ci])
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(final_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(final_yoy)
            actuals_yoy.append(actual_yoy)

            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": res["as_of"].strftime("%Y-%m-%d"),
                "yellen_yoy": round(float(res["yellen_yoy"]), 3),
                "ets_mom": (round(float(ets_mom), 4) if ets_mom is not None else None),
                "ets_yoy": (round(float(ets_yoy), 3) if np.isfinite(ets_yoy) else None),
                "ets_used": bool(ets_used),
                "weight_yellen": round(float(w_yellen), 3),
                "pred_mom": round(float(final_mom), 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(float(final_yoy), 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(float(final_yoy) - actual_yoy, 3),
            })
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts"}

    pm = np.asarray(preds_mom, dtype=float); am = np.asarray(actuals_mom, dtype=float)
    py = np.asarray(preds_yoy, dtype=float); ay = np.asarray(actuals_yoy, dtype=float)
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
        "etsUsedCuts": int(n_ets_used),
        "etsUsedPct": round(100.0 * n_ets_used / len(rows), 1) if rows else 0.0,
        "ensembleWeightYellen": _ENSEMBLE_W_YELLEN,
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Public API: live nowcast
# ---------------------------------------------------------------------------


def run_ets_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> EtsNowcastResult:
    """Live nowcast: Yellen 1.1 ⊕ ETS(MoM, seasonal_periods=12), 50/50.

    On any ETS failure, we fall through to Yellen 1.1 only. Bands are
    shifted by the same yoy delta so the base model's width is preserved.
    """
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

    # ---- ETS forecast (heavily wrapped) ----
    ets_mom: float | None = None
    try:
        ets_mom = _fit_ets_and_forecast_one_step(y_mom)
    except Exception:
        ets_mom = None

    (
        final_mom,
        final_yoy,
        lo80_yoy,
        hi80_yoy,
        ets_yoy,
        ets_used,
        w_yellen,
    ) = _ensemble_yellen_ets(
        yellen_yoy=yellen_yoy,
        yellen_lo80=yellen_lo80,
        yellen_hi80=yellen_hi80,
        yellen_mom=mid_cal,
        ets_mom=ets_mom,
        last_cpi_train=last_cpi,
        target_month_end=target_month_end,
        cpi_full=cpi,
    )

    if (hi80_yoy - final_yoy) < _RESID_FLOOR:
        hi80_yoy = final_yoy + _RESID_FLOOR
    if (final_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = final_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return EtsNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=float(final_mom),
        pred_yoy=float(final_yoy),
        lo80_yoy=float(lo80_yoy),
        hi80_yoy=float(hi80_yoy),
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        yellen_pred_yoy=float(yellen_yoy),
        ets_pred_yoy=float(ets_yoy) if np.isfinite(ets_yoy) else float("nan"),
        ets_pred_mom=float(ets_mom) if (ets_mom is not None and np.isfinite(ets_mom)) else float("nan"),
        ets_used=bool(ets_used),
        weight_yellen=float(w_yellen),
    )
