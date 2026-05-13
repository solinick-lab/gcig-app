"""Median ensemble of the top-3 nowcasters: Yellen 1.1 + Yellen 1.2 + clev_nowcast.

Strategy: each of the three best individual nowcasters has its own bias
profile. Yellen 1.1 (clev_calibrated) carries a Ridge post-hoc
correction. Yellen 1.2 (clev_trajectory) leans on the slope/momentum of
Cleveland's daily-updated nowcast. Plain clev_nowcast feeds the level
straight in. Per-cut MEDIAN of the three point predictions cancels
idiosyncratic errors without letting any single model dominate, while
max-of-his / min-of-los for the bands gives a conservative envelope (no
band-narrowing artifact from averaging individually-tight intervals).

Backtest: each cut runs all three nowcasters internally on the same
training window, then collapses (pred_yoy, lo80, hi80) via:
  point_yoy = median(yoy_a, yoy_b, yoy_c)
  point_mom = median(mom_a, mom_b, mom_c)
  lo80      = min(lo_a, lo_b, lo_c)
  hi80      = max(hi_a, hi_b, hi_c)

Public API (standard interface):
  backtest_top3med_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_top3med_nowcast(as_of_day=20) -> Top3MedNowcastResult
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

# Yellen 1.1 (clev_calibrated) helpers
from .nowcast_clev_calibrated import (
    _build_calibration_dataset,
    _fit_calibrator,
    _apply_calibration,
    _recent_vol,
)

# Yellen 1.2 (clev_trajectory) helpers
from .nowcast_clev_trajectory import (
    _build_supervised_trajectory,
    _fit_quantile_models as _fit_quantile_models_traj,
    _predict_triple as _predict_triple_traj,
    _trajectory_features_for_month,
    _safe_get_clev as _safe_get_clev_traj,
    _MOM_LO_CLIP as _TRAJ_LO_CLIP,
    _MOM_HI_CLIP as _TRAJ_HI_CLIP,
)

# clev_nowcast helpers (also reused by Yellen 1.1)
from .nowcast_clev import (
    _safe_get_clev,
    _build_supervised_clev,
    _fit_quantile_models,
    _predict_triple,
    _clev_features_for_month,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)


warnings.filterwarnings("ignore")


@dataclass
class Top3MedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    member_preds_yoy: tuple[float, float, float]  # (calibrated, trajectory, raw)


# ---------------------------------------------------------------------------
# Per-cut single-model inference (factored so backtest stays readable)
# ---------------------------------------------------------------------------


def _infer_clev_raw(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    cpi_full: pd.Series,
) -> tuple[float, float, float, float] | None:
    """Run plain clev_nowcast on a training cut. Return (mid_mom, yoy, lo_yoy, hi_yoy) or None."""
    try:
        X, y = _build_supervised_clev(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None
        models = _fit_quantile_models(X, y)
        cols = list(X.columns)

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            return None
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        try:
            feats.update(_clev_features_for_month(clev, target_month_end, train_panel))
        except Exception:
            pass

        x_inf = pd.Series(feats).reindex(cols).fillna(
            X.median(numeric_only=True)
        ).fillna(0.0)
        mid, lo, hi = _predict_triple(models, x_inf, cols)
        mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi_full)
        lo_yoy = _mom_to_yoy(lo, last_cpi_train, target_month_end, cpi_full)
        hi_yoy = _mom_to_yoy(hi, last_cpi_train, target_month_end, cpi_full)
        return mid, yoy, lo_yoy, hi_yoy
    except Exception:
        return None


def _infer_clev_calibrated(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    cpi_full: pd.Series,
) -> tuple[float, float, float, float] | None:
    """Run Yellen 1.1 (clev_calibrated) on a training cut."""
    try:
        X, y = _build_supervised_clev(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None
        models = _fit_quantile_models(X, y)
        cols = list(X.columns)

        train_y_mom = build_target(train_panel).dropna()
        F_cal, t_cal = _build_calibration_dataset(
            X, y, models, cols, train_panel, train_y_mom,
        )
        ridge = _fit_calibrator(F_cal, t_cal)

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            return None
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        try:
            feats.update(_clev_features_for_month(clev, target_month_end, train_panel))
        except Exception:
            pass

        x_inf = pd.Series(feats).reindex(cols).fillna(
            X.median(numeric_only=True)
        ).fillna(0.0)
        mid_base, lo_base, hi_base = _predict_triple(models, x_inf, cols)
        mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

        inf_vol = _recent_vol(train_y_mom, target_month_end)
        inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
        if not np.isfinite(inf_yml):
            inf_yml = 0.0

        mid_cal, lo_cal, hi_cal, _bias = _apply_calibration(
            ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
        )
        mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        yoy = _mom_to_yoy(mid_cal, last_cpi_train, target_month_end, cpi_full)
        lo_yoy = _mom_to_yoy(lo_cal, last_cpi_train, target_month_end, cpi_full)
        hi_yoy = _mom_to_yoy(hi_cal, last_cpi_train, target_month_end, cpi_full)
        return mid_cal, yoy, lo_yoy, hi_yoy
    except Exception:
        return None


def _infer_clev_trajectory(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    cpi_full: pd.Series,
) -> tuple[float, float, float, float] | None:
    """Run Yellen 1.2 (clev_trajectory) on a training cut."""
    try:
        X, y = _build_supervised_trajectory(
            train_panel, daily_frame, clev, as_of_day=as_of_day,
        )
        if len(X) < 24:
            return None
        models = _fit_quantile_models_traj(X, y)
        cols = list(X.columns)

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            return None
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        )
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        try:
            feats.update(
                _trajectory_features_for_month(clev, target_month_end, train_panel)
            )
        except Exception:
            pass

        x_inf = pd.Series(feats).reindex(cols).fillna(
            X.median(numeric_only=True)
        ).fillna(0.0)
        mid, lo, hi = _predict_triple_traj(models, x_inf, cols)
        mid = float(np.clip(mid, _TRAJ_LO_CLIP, _TRAJ_HI_CLIP))

        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi_full)
        lo_yoy = _mom_to_yoy(lo, last_cpi_train, target_month_end, cpi_full)
        hi_yoy = _mom_to_yoy(hi, last_cpi_train, target_month_end, cpi_full)
        return mid, yoy, lo_yoy, hi_yoy
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Median combiner
# ---------------------------------------------------------------------------


def _combine_median(
    members: list[tuple[float, float, float, float]],
) -> tuple[float, float, float, float]:
    """Median point + max-his/min-los band envelope across members.

    Each member is (mom, yoy, lo_yoy, hi_yoy). Returns combined
    (mom, yoy, lo_yoy, hi_yoy).
    """
    moms = [m[0] for m in members]
    yoys = [m[1] for m in members]
    los = [m[2] for m in members]
    his = [m[3] for m in members]
    return (
        float(np.median(moms)),
        float(np.median(yoys)),
        float(min(los)),
        float(max(his)),
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_top3med_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the top-3 median ensemble.

    For each cut, runs Yellen 1.1, Yellen 1.2 and clev_nowcast on the
    same training window, then takes per-cut median for the point and
    max-of-his/min-of-los for the bands.
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

            # Run all three members on this cut
            m_cal = _infer_clev_calibrated(
                train_panel, daily_frame, clev, target_month_end, as_of_day, cpi,
            )
            m_traj = _infer_clev_trajectory(
                train_panel, daily_frame, clev, target_month_end, as_of_day, cpi,
            )
            m_raw = _infer_clev_raw(
                train_panel, daily_frame, clev, target_month_end, as_of_day, cpi,
            )

            members = [m for m in (m_cal, m_traj, m_raw) if m is not None]
            if len(members) == 0:
                continue
            # If any one member dropped out, fall back to the remaining
            # members but require at least two for a stable median.
            if len(members) < 2:
                continue

            mid_mom, mid_yoy, lo_yoy, hi_yoy = _combine_median(members)

            actual_mom = float(y_mom.iloc[ci])
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(mid_yoy)
            actuals_yoy.append(actual_yoy)

            row = {
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": _as_of_for_month(
                    target_month_end + pd.offsets.MonthBegin(-1), as_of_day,
                ).strftime("%Y-%m-%d"),
                "pred_mom": round(mid_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(mid_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(mid_yoy - actual_yoy, 3),
                "lo80_yoy": round(lo_yoy, 3),
                "hi80_yoy": round(hi_yoy, 3),
                "n_members": len(members),
                "yoy_calibrated": round(m_cal[1], 3) if m_cal is not None else None,
                "yoy_trajectory": round(m_traj[1], 3) if m_traj is not None else None,
                "yoy_raw": round(m_raw[1], 3) if m_raw is not None else None,
            }
            rows.append(row)
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


def run_top3med_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> Top3MedNowcastResult:
    """Live nowcast: median of Yellen 1.1, Yellen 1.2 and raw clev_nowcast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # ---- Member 1: Yellen 1.1 (clev_calibrated) ----
    X_clev, y_clev = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    models_clev = _fit_quantile_models(X_clev, y_clev)
    cols_clev = list(X_clev.columns)

    F_cal, t_cal = _build_calibration_dataset(
        X_clev, y_clev, models_clev, cols_clev, panel, y_mom,
    )
    ridge = _fit_calibrator(F_cal, t_cal)

    feats = rich_features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    feats_clev_only = dict(feats)
    try:
        feats_clev_only.update(
            _clev_features_for_month(clev, target_month_end, panel)
        )
    except Exception:
        pass

    x_inf_clev = pd.Series(feats_clev_only).reindex(cols_clev).fillna(
        X_clev.median(numeric_only=True)
    ).fillna(0.0)
    mid_base, lo_base, hi_base = _predict_triple(models_clev, x_inf_clev, cols_clev)
    mid_base = float(np.clip(mid_base, _MOM_LO_CLIP, _MOM_HI_CLIP))

    inf_vol = _recent_vol(y_mom, target_month_end)
    inf_yml = float(feats_clev_only.get("clev_yoy_minus_lag", 0.0))
    if not np.isfinite(inf_yml):
        inf_yml = 0.0

    mid_cal, lo_cal, hi_cal, _bias = _apply_calibration(
        ridge, mid_base, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    yoy_cal = _mom_to_yoy(mid_cal, last_cpi, target_month_end, cpi)
    lo_cal_yoy = _mom_to_yoy(lo_cal, last_cpi, target_month_end, cpi)
    hi_cal_yoy = _mom_to_yoy(hi_cal, last_cpi, target_month_end, cpi)

    # ---- Member 2: Yellen 1.2 (clev_trajectory) ----
    X_traj, y_traj = _build_supervised_trajectory(
        panel, daily_frame, clev, as_of_day=as_of_day,
    )
    models_traj = _fit_quantile_models_traj(X_traj, y_traj)
    cols_traj = list(X_traj.columns)

    feats_traj = dict(feats)
    try:
        feats_traj.update(
            _trajectory_features_for_month(clev, target_month_end, panel)
        )
    except Exception:
        pass
    x_inf_traj = pd.Series(feats_traj).reindex(cols_traj).fillna(
        X_traj.median(numeric_only=True)
    ).fillna(0.0)
    mid_traj, lo_traj, hi_traj = _predict_triple_traj(models_traj, x_inf_traj, cols_traj)
    mid_traj = float(np.clip(mid_traj, _TRAJ_LO_CLIP, _TRAJ_HI_CLIP))

    yoy_traj = _mom_to_yoy(mid_traj, last_cpi, target_month_end, cpi)
    lo_traj_yoy = _mom_to_yoy(lo_traj, last_cpi, target_month_end, cpi)
    hi_traj_yoy = _mom_to_yoy(hi_traj, last_cpi, target_month_end, cpi)

    # ---- Member 3: raw clev_nowcast (reuse the trained X_clev/models_clev) ----
    yoy_raw = _mom_to_yoy(mid_base, last_cpi, target_month_end, cpi)
    lo_raw_yoy = _mom_to_yoy(lo_base, last_cpi, target_month_end, cpi)
    hi_raw_yoy = _mom_to_yoy(hi_base, last_cpi, target_month_end, cpi)

    members: list[tuple[float, float, float, float]] = [
        (mid_cal, yoy_cal, lo_cal_yoy, hi_cal_yoy),
        (mid_traj, yoy_traj, lo_traj_yoy, hi_traj_yoy),
        (mid_base, yoy_raw, lo_raw_yoy, hi_raw_yoy),
    ]

    mid_mom, mid_yoy, lo_yoy, hi_yoy = _combine_median(members)

    if (hi_yoy - mid_yoy) < _RESID_FLOOR:
        hi_yoy = mid_yoy + _RESID_FLOOR
    if (mid_yoy - lo_yoy) < _RESID_FLOOR:
        lo_yoy = mid_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return Top3MedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_mom,
        pred_yoy=mid_yoy,
        lo80_yoy=lo_yoy,
        hi80_yoy=hi_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        member_preds_yoy=(yoy_cal, yoy_traj, yoy_raw),
    )
