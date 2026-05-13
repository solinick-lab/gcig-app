"""Bootstrap-aggregated (bagged) wrapper around `nowcast_clev_calibrated`.

The Yellen 1.1 baseline (post-hoc Ridge calibration on top of the clev
nowcast stack) achieves ~0.1142 RMSE YoY on the standard 24-month
walk-forward window. Its remaining error is dominated by training-window
variance: which ~60 monthly rows land in the supervised matrix at each cut
swings the q=0.5 GBR fit non-trivially, and the Ridge correction layer
inherits whatever in-sample residual structure the base learner shows.

Bagging the BASE quantile model is the textbook variance reduction:
  - For each backtest cut, draw 50 bootstrap subsamples (85% of rows,
    with replacement) of the supervised matrix produced by the same
    feature pipeline used by `nowcast_clev_calibrated`.
  - Fit q=0.5 GBR on each subsample (median-only — we don't need
    quantile bands from the bag because the calibration shift is
    applied as a scalar to the existing clev base lo/hi).
  - Aggregate the 50 per-bag in-sample medians into a SINGLE pseudo
    "median model" by taking the median across bags row-by-row, then
    re-build the calibration dataset from those bagged in-sample
    predictions and fit Ridge on that. At inference, predict the
    50 per-bag medians on the live feature row and aggregate via
    `median of bag medians` to form the bagged base prediction.
  - Apply the bagged-trained Ridge calibrator to the bagged base
    prediction; bands come from the unbagged clev quantile triple
    shifted by the calibration scalar (preserving the band logic from
    Yellen 1.1).

We deliberately keep n_estimators slightly slimmer than the baseline
(`200` instead of `400`) so 50 bags fit comfortably per cut. The
ensemble's variance reduction more than compensates.

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].

Public API:
  backtest_yellen_bagged_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_yellen_bagged_nowcast(as_of_day=20) -> YellenBaggedNowcastResult
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
from .nowcast_clev import (
    _build_supervised_clev,
    _clev_features_for_month,
    _fit_quantile_models,
    _mom_to_yoy,
    _predict_triple,
    _safe_get_clev,
    _MOM_HI_CLIP,
    _MOM_LO_CLIP,
    _RESID_FLOOR,
)
from .nowcast_clev_calibrated import (
    _apply_calibration,
    _build_calibration_dataset,
    _fit_calibrator,
    _recent_vol,
)
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_N_BAGS = 50
_BAG_FRAC = 0.85
_RANDOM_STATE = 42

# Slimmer than the 400-tree baseline so 50 bags per cut stay within
# wall-time budget. q=0.5 only — the bag aggregate produces just the
# median; bands fall out of the unbagged clev quantile triple.
_GBR_BAG_PARAMS = dict(
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
    loss="quantile",
    alpha=0.5,
)


@dataclass
class YellenBaggedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    bias_shift_mom: float
    n_calib_rows: int
    n_bags: int


# ---------------------------------------------------------------------------
# Bagging helpers
# ---------------------------------------------------------------------------


def _fit_bagged_medians(
    X: pd.DataFrame,
    y: pd.Series,
    n_bags: int = _N_BAGS,
    frac: float = _BAG_FRAC,
    seed: int = _RANDOM_STATE,
) -> list[GradientBoostingRegressor]:
    """Fit `n_bags` q=0.5 GBR on bootstrap subsamples of (X, y).

    Each bag draws ceil(frac * n_rows) row indices WITH replacement from
    the full supervised matrix. A separate RNG-seeded GBR is trained on
    each bag so all randomness (subsample + GBR internal) is reproducible
    and bag-distinct.
    """
    n = len(X)
    if n == 0:
        return []
    n_draw = max(1, int(np.ceil(frac * n)))
    rng = np.random.default_rng(seed)
    bags: list[GradientBoostingRegressor] = []
    Xv = X.values
    yv = y.values
    for b in range(n_bags):
        idx = rng.integers(0, n, size=n_draw)
        try:
            gbr = GradientBoostingRegressor(
                random_state=int(seed + b),
                **_GBR_BAG_PARAMS,
            ).fit(Xv[idx], yv[idx])
            bags.append(gbr)
        except Exception:
            continue
    return bags


def _bagged_in_sample_medians(
    bags: list[GradientBoostingRegressor],
    X: pd.DataFrame,
) -> np.ndarray:
    """Return the median across bags of in-sample predictions.

    Shape: (n_rows,). Used to feed the calibration dataset builder so the
    Ridge calibrator learns to correct the BAGGED base model's residual
    structure rather than a single-fit base model's.
    """
    if not bags or len(X) == 0:
        return np.zeros(len(X))
    Xv = X.values
    preds = np.vstack([b.predict(Xv) for b in bags])  # (n_bags, n_rows)
    return np.median(preds, axis=0)


def _bagged_predict_median(
    bags: list[GradientBoostingRegressor],
    x_row: np.ndarray,
) -> float:
    """Aggregate `bags` predictions on a single row via median-of-bag-medians."""
    if not bags:
        return 0.0
    preds = np.array([float(b.predict(x_row)[0]) for b in bags], dtype=float)
    return float(np.median(preds))


class _BaggedMedianModel:
    """Drop-in replacement for `models[0.5]` consumed by `_build_calibration_dataset`.

    The calibration dataset builder calls `models[0.5].predict(Xv)` to get
    the median model's in-sample predictions. We override `predict` so it
    returns the median-across-bags vector directly — keeping the
    calibration code path identical to Yellen 1.1.
    """

    def __init__(self, bags: list[GradientBoostingRegressor]):
        self._bags = bags

    def predict(self, Xv: np.ndarray) -> np.ndarray:
        if not self._bags or len(Xv) == 0:
            return np.zeros(len(Xv))
        preds = np.vstack([b.predict(Xv) for b in self._bags])
        return np.median(preds, axis=0)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_yellen_bagged_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of Yellen 1.1 with 50-bag bootstrap aggregation."""
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

            # --- baseline quantile models for bands (q=0.1/0.5/0.9). The
            # band ENDPOINTS come from the standard unbagged stack so we
            # preserve Yellen 1.1's quantile widths exactly. The CENTER
            # is replaced by the bagged median below.
            base_models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # --- 50-bag bootstrap aggregation of q=0.5 only ---
            bags = _fit_bagged_medians(
                X, y, n_bags=_N_BAGS, frac=_BAG_FRAC, seed=_RANDOM_STATE,
            )
            if not bags:
                continue

            # --- calibration: feed the BAGGED median as the base in-sample
            # prediction so Ridge learns to correct the bag-aggregate's
            # residual bias (not the single-fit baseline's).
            bagged_base_model = _BaggedMedianModel(bags)
            cal_models = {0.5: bagged_base_model}
            train_y_mom = build_target(train_panel).dropna()
            F_cal, t_cal = _build_calibration_dataset(
                X, y, cal_models, cols, train_panel, train_y_mom
            )
            ridge = _fit_calibrator(F_cal, t_cal)

            # --- inference features (identical to clev/clev_calibrated) ---
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

            # bands from the unbagged quantile triple
            _, lo_base, hi_base = _predict_triple(base_models, x_inf, cols)

            # CENTER is the median-of-bag-medians on the live row
            x_row = x_inf.values.reshape(1, -1)
            mid_bag = _bagged_predict_median(bags, x_row)
            mid_bag = float(np.clip(mid_bag, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # --- apply calibration to the bagged center ---
            inf_vol = _recent_vol(train_y_mom, target_month_end)
            inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
            if not np.isfinite(inf_yml):
                inf_yml = 0.0

            mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
                ridge, mid_bag, lo_base, hi_base, inf_vol, inf_yml,
            )
            mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(mid_cal, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid_cal)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom_bag": round(mid_bag, 4),
                "pred_mom": round(mid_cal, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "bias_shift": round(bias_shift, 4),
                "n_calib_rows": len(F_cal),
                "n_bags": len(bags),
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
        "nBags": _N_BAGS,
        "bagFrac": _BAG_FRAC,
        "rows": rows,
    }


def run_yellen_bagged_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> YellenBaggedNowcastResult:
    """Live Yellen-bagged nowcast: 50-bag base + Ridge calibration."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    base_models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    bags = _fit_bagged_medians(
        X, y, n_bags=_N_BAGS, frac=_BAG_FRAC, seed=_RANDOM_STATE,
    )

    bagged_base_model = _BaggedMedianModel(bags)
    cal_models = {0.5: bagged_base_model}
    y_mom = build_target(panel).dropna()
    F_cal, t_cal = _build_calibration_dataset(
        X, y, cal_models, cols, panel, y_mom
    )
    ridge = _fit_calibrator(F_cal, t_cal)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

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
    _, lo_base, hi_base = _predict_triple(base_models, x_inf, cols)

    x_row = x_inf.values.reshape(1, -1)
    mid_bag = _bagged_predict_median(bags, x_row)
    mid_bag = float(np.clip(mid_bag, _MOM_LO_CLIP, _MOM_HI_CLIP))

    inf_vol = _recent_vol(y_mom, target_month_end)
    inf_yml = float(feats.get("clev_yoy_minus_lag", 0.0))
    if not np.isfinite(inf_yml):
        inf_yml = 0.0

    mid_cal, lo_cal, hi_cal, bias_shift = _apply_calibration(
        ridge, mid_bag, lo_base, hi_base, inf_vol, inf_yml,
    )
    mid_cal = float(np.clip(mid_cal, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid_cal, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_cal, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_cal, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return YellenBaggedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid_cal,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        bias_shift_mom=bias_shift,
        n_calib_rows=int(len(F_cal)),
        n_bags=len(bags),
    )
