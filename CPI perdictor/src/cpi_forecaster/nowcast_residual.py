"""Iterative residual learning CPI nowcaster.

The pure-quantile nowcaster (`nowcast_quantile.py`) sets a strong baseline
by fitting a q=0.5 GBR with pinball loss. But its in-sample residuals
aren't pure noise — they often retain systematic structure the GBR's
shallow trees couldn't capture (linear effects, smooth interactions
between scaled macro features, etc.).

This module wraps a SECOND-STAGE residual learner around the quantile
GBR. Pipeline:

  1. Fit a q=0.5 GradientBoostingRegressor on (X, y). Call its in-sample
     predictions yhat_q.
  2. Compute residuals r = y - yhat_q.
  3. Fit a strongly-regularized Ridge on (X, r) — predict what the GBR
     missed. Call its predictions yhat_r.
  4. Final point forecast: yhat_final = yhat_q + yhat_r.
  5. For the 80% interval, fit q=0.1 and q=0.9 GBRs as in
     nowcast_quantile, then shift each band by the mean of yhat_r on the
     training set. (The residual model is symmetric; shifting both bands
     by the same correction keeps the interval width honest.)
  6. Sort the triple post-hoc to handle quantile crossing, clip MoM,
     chain to YoY.

Concern: residual learning amplifies overfitting on small samples, since
stage 2 chases stage-1 leftover signal that may just be sample noise.
We mitigate with a high-alpha RidgeCV (grid skews toward heavy
regularization) and StandardScaler so the regularization penalty is
comparable across features.

Reuses `_build_supervised`, `_as_of_for_month`, and DEFAULT_AS_OF_DAY
from `nowcast.py` so feature engineering and as-of timing stay identical
to the rest of the family. Doesn't modify any other module.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval to avoid collapse

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Heavy-regularization grid for the residual Ridge. The residual signal
# is small and noisy, so we want alpha to be able to push toward "predict
# zero" if there's nothing systematic left.
_RESID_RIDGE_ALPHAS = np.logspace(0, 4, 25)  # 1 ... 10000


@dataclass
class ResidualNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class ResidualNowcastModel:
    gbr_models: dict[float, GradientBoostingRegressor]
    resid_scaler: StandardScaler
    resid_ridge: RidgeCV
    feature_cols: list[str]
    mean_resid_correction: float
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (point_mom, lo10, hi90) for one feature row.

        Point = q=0.5 GBR + Ridge residual correction.
        Bands = q=0.1 / q=0.9 GBR shifted by the mean residual correction
        observed in-sample, then sorted to enforce monotonicity in case of
        quantile crossing.
        """
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)

        # Stage-1 quantile predictions.
        q_preds = {q: float(self.gbr_models[q].predict(x_aligned)[0]) for q in _QUANTILES}

        # Stage-2 residual prediction (operates on scaled features).
        x_scaled = self.resid_scaler.transform(x_aligned)
        resid_pred = float(self.resid_ridge.predict(x_scaled)[0])

        # Final point forecast: median + residual correction.
        point = q_preds[0.5] + resid_pred

        # Shift bands by the *mean* residual correction observed in-sample.
        # We use mean(yhat_r) rather than the per-row resid_pred so the band
        # width isn't perturbed by a single feature row.
        lo = q_preds[0.1] + self.mean_resid_correction
        hi = q_preds[0.9] + self.mean_resid_correction

        # Sort for quantile-crossing safety, but keep `point` as the median
        # of the (lo, point, hi) triple.
        triple = np.sort(np.array([lo, point, hi], dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


def fit_residual_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ResidualNowcastModel:
    """Fit stage-1 quantile GBRs, then a stage-2 Ridge on stage-1 residuals."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    # Stage 1: three quantile GBRs (0.1, 0.5, 0.9).
    gbr_models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        gbr_models[q] = gbr

    # Stage 1 in-sample median predictions and residuals.
    yhat_q = gbr_models[0.5].predict(Xv)
    resid = yv - yhat_q

    # Stage 2: Ridge on residuals. Scale features so the alpha grid is
    # meaningful across heterogeneous magnitudes.
    scaler = StandardScaler().fit(Xv)
    Xs = scaler.transform(Xv)
    ridge = RidgeCV(alphas=_RESID_RIDGE_ALPHAS).fit(Xs, resid)

    # Mean in-sample residual correction (used to shift the lo/hi bands).
    yhat_r_train = ridge.predict(Xs)
    mean_resid_correction = float(np.mean(yhat_r_train))

    return ResidualNowcastModel(
        gbr_models=gbr_models,
        resid_scaler=scaler,
        resid_ridge=ridge,
        feature_cols=cols,
        mean_resid_correction=mean_resid_correction,
        as_of_day=as_of_day,
    )


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Feature row for the cut, simulating as-of `as_of_day` of target month."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Same MoM->YoY chain as nowcast_quantile."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


def run_residual_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> ResidualNowcastResult:
    """Pull live panels, fit residual-learning model, produce current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_residual_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

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

    return ResidualNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_residual_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the residual-learning nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train stage-1 quantile GBRs + stage-2 Ridge on data strictly before t
      - predict t's MoM as q=0.5_pred + ridge_residual_pred
      - clip to [-1.5, 2.5], chain to YoY against actual published CPI

    Same try/except per cut and same return shape as the rest of the
    nowcast family.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

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

            model = fit_residual_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day,
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
        "rows": rows,
    }
