"""Split-conformal calibration on top of the Cleveland-Fed-augmented nowcaster.

Combines two ideas that have each helped on their own:

  1. `nowcast_clev` — quantile_rich features + Cleveland Fed inflation
     nowcast features. The Cleveland feed (or FRED median CPI fallback)
     is a strong informative prior on YoY CPI; mixing it into the
     quantile GBR stack improves both bias and tail behavior.
  2. Split-conformal calibration. Holding out the last 20% of supervised
     training rows (chronologically) lets us:
       - estimate a signed-bias correction on the median forecast
         (mean of `actual - q0.5_pred` on calibration), and
       - widen/narrow the q0.1/q0.9 band to actually achieve the
         nominal 80% coverage via the standard split-conformal q_hat
         (= ceil((n+1)*0.8)/n quantile of nonconformity scores).

The previous `nowcast_conformal` attempt suffered because it didn't
refit on the full data after calibration — the deployed model was
trained on only 80% of the supervised set, throwing away the most
recent (and arguably most informative) rows. Here we explicitly refit
on the FULL training matrix once the calibration constants are pinned
down, so only the bias_shift and interval_pad travel forward, while
the deployed quantile GBRs see every row.

If calibration falls below `_MIN_CAL_ROWS`, we degrade gracefully to
the plain Cleveland clev_nowcast (no shift, no pad) — at low n the
q_hat estimate has too much variance to help.

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].

Public API:
  fit_clev_conformal_model(panel, daily_frame, as_of_day=20) -> ClevConformalModel
  backtest_clev_conformal_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_clev_conformal_nowcast(as_of_day=20) -> ClevConformalNowcastResult
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
from .nowcast_clev import (
    _build_supervised_clev,
    _clev_features_for_month,
    _safe_get_clev,
)
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05      # minimum half-width on YoY interval to avoid collapse
_CAL_FRACTION = 0.20     # tail share held out for calibration
_MIN_CAL_ROWS = 10       # below this, fall back to plain quantile (no calibration)
_TARGET_COVERAGE = 0.80

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class ClevConformalNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_conformal: bool
    bias_shift: float
    interval_pad: float


@dataclass
class ClevConformalModel:
    models: dict
    feature_cols: list[str]
    as_of_day: int
    bias_shift: float       # mean signed residual on calibration set
    interval_pad: float     # q_hat from conformity scores (MoM units)
    used_conformal: bool    # False if fell back to plain quantile
    median_fillin: pd.Series  # column medians from full X (for inference NA imputation)

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (median_corrected, lo_corrected, hi_corrected) MoM.

        Sorts the raw triple to enforce monotonicity in case of quantile
        crossing, then applies the calibration constants. If conformal
        was skipped (small calibration set), bias_shift=0 and
        interval_pad=0 so this degenerates to plain sorted quantile.
        """
        aligned = (
            x.reindex(self.feature_cols)
             .fillna(self.median_fillin)
             .fillna(0.0)
             .values.reshape(1, -1)
        )
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        raw_lo, raw_med, raw_hi = float(triple[0]), float(triple[1]), float(triple[2])
        med = raw_med + self.bias_shift
        lo = raw_lo - self.interval_pad + self.bias_shift
        hi = raw_hi + self.interval_pad + self.bias_shift
        return med, lo, hi


# ---------------------------------------------------------------------------
# Fit helpers
# ---------------------------------------------------------------------------


def _fit_quantile_models(Xv: np.ndarray, yv: np.ndarray) -> dict:
    """Fit one GBR per quantile in `_QUANTILES` on raw arrays."""
    models: dict = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
    return models


def fit_clev_conformal_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict | None = None,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ClevConformalModel:
    """Fit clev quantile GBRs with split-conformal calibration on top.

    Steps:
      1. Build supervised (X, y) using the clev feature builder (same one
         `nowcast_clev` uses — quantile_rich + Cleveland-derived features).
      2. Chronological 80/20 split into proper-train / calibration.
      3. Fit q={0.1, 0.5, 0.9} GBRs on the proper-train block ONLY.
      4. Score calibration:
         - signed_resid_i = y_i - yhat_med_i        (median bias)
         - nonconf_i      = max(yhat_lo - y, y - yhat_hi, 0)
      5. Calibration constants:
         - bias_shift = mean(signed_resid)
         - interval_pad = ceil((n+1)*0.8)/n quantile of nonconf
      6. REFIT q={0.1, 0.5, 0.9} GBRs on the FULL (X, y). The deployed
         model uses every row of training data; only the calibration
         constants from step 5 carry forward. This is the key difference
         from the earlier conformal attempt that left 20% on the table.

    If calibration size falls below `_MIN_CAL_ROWS`, fall back to plain
    quantile (bias_shift=0, interval_pad=0) — too few points to estimate
    q_hat reliably.
    """
    if clev is None:
        clev = _safe_get_clev()

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values
    yv = y.values
    n_total = len(yv)

    bias_shift = 0.0
    interval_pad = 0.0
    used_conformal = False

    try:
        n_cal = int(np.floor(n_total * _CAL_FRACTION))
        n_train = n_total - n_cal
        if n_cal >= _MIN_CAL_ROWS and n_train >= _MIN_CAL_ROWS:
            X_train_v = Xv[:n_train]
            y_train_v = yv[:n_train]
            X_cal_v = Xv[n_train:]
            y_cal_v = yv[n_train:]

            cal_models = _fit_quantile_models(X_train_v, y_train_v)

            yhat_lo = cal_models[0.1].predict(X_cal_v)
            yhat_med = cal_models[0.5].predict(X_cal_v)
            yhat_hi = cal_models[0.9].predict(X_cal_v)

            # Defensive monotonicity sort row-wise before scoring.
            stacked = np.vstack([yhat_lo, yhat_med, yhat_hi])
            stacked = np.sort(stacked, axis=0)
            yhat_lo, yhat_med, yhat_hi = stacked[0], stacked[1], stacked[2]

            signed_resid = y_cal_v - yhat_med
            bias_shift = float(np.mean(signed_resid))

            nonconf = np.maximum.reduce([
                yhat_lo - y_cal_v,
                y_cal_v - yhat_hi,
                np.zeros_like(y_cal_v),
            ])

            n = len(nonconf)
            level = min(1.0, np.ceil((n + 1) * _TARGET_COVERAGE) / n)
            interval_pad = float(np.quantile(nonconf, level))
            if not np.isfinite(interval_pad) or interval_pad < 0:
                interval_pad = 0.0
            used_conformal = True
    except Exception:
        bias_shift = 0.0
        interval_pad = 0.0
        used_conformal = False

    # Final inference model: refit on the FULL training data.
    final_models = _fit_quantile_models(Xv, yv)

    median_fillin = X.median(numeric_only=True)

    return ClevConformalModel(
        models=final_models,
        feature_cols=cols,
        as_of_day=as_of_day,
        bias_shift=bias_shift,
        interval_pad=interval_pad,
        used_conformal=used_conformal,
        median_fillin=median_fillin,
    )


# ---------------------------------------------------------------------------
# Inference feature row (mirrors the clev module's pattern)
# ---------------------------------------------------------------------------


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    full_panel: pd.DataFrame | None = None,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Build the inference feature row for `target_month_end`.

    Uses clev features + quantile_rich + lag features, simulating an
    as-of of `as_of_day` of the target month. `full_panel` (when given)
    is used for the FRED-median-CPI fallback inside
    `_clev_features_for_month` so the fallback can pull historical
    median CPI even during walk-forward training cuts.
    """
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = rich_features_at(daily_frame, as_of)

    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    panel_for_clev = full_panel if full_panel is not None else train_panel
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel_for_clev))
    except Exception:
        pass

    return feats, as_of


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


def backtest_clev_conformal_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the split-conformal Cleveland nowcaster.

    For each historical cut t in the trailing `window_months`:
      - take train_panel = panel[< t]
      - chronologically split supervised (X, y) 80/20
      - fit quantile GBRs on the 80%, score the 20%, derive
        bias_shift + interval_pad (split-conformal q_hat)
      - REFIT quantile GBRs on the FULL train_panel and apply the
        calibration constants to predict t
      - clip MoM to [-1.5, 2.5], chain to YoY against actual CPI[t-12]

    A single failed cut is skipped (try/except). Cleveland scrape is
    fetched ONCE up front; the historical archive in that response
    covers all cuts.

    Return shape mirrors `nowcast.backtest_nowcast` exactly, plus a
    `usedClevScrape` flag.
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

            model = fit_clev_conformal_model(
                train_panel, daily_frame, clev=clev, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, clev, target_month_end,
                as_of_day, full_panel=panel,
            )

            pred_mom, _, _ = model.predict_one(pd.Series(feats))
            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(pred_mom, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "biasShift": round(model.bias_shift, 4),
                "intervalPad": round(model.interval_pad, 4),
                "usedConformal": bool(model.used_conformal),
            })
        except Exception:
            # One bad cut shouldn't tank the whole backtest.
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


def run_clev_conformal_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ClevConformalNowcastResult:
    """Live nowcast: fresh Cleveland scrape + clev quantile + split-conformal."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    model = fit_clev_conformal_model(panel, daily_frame, clev=clev, as_of_day=as_of_day)

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

    pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
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

    return ClevConformalNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        used_conformal=model.used_conformal,
        bias_shift=model.bias_shift,
        interval_pad=model.interval_pad,
    )
