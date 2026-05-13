"""Bagged quantile-regression CPI nowcaster.

The single quantile-median GBR in `nowcast_quantile.py` produces a
median forecast on each cut, but that single fit is at the mercy of
which 60-or-so months happen to be in the training window. A handful
of unlucky cuts (where the tree splits land badly for the upcoming
month) drag the YoY RMSE up. Bagging is the textbook fix: train many
GBRs on bootstrap subsamples of the rows and aggregate. Variance of
the aggregate falls roughly as 1/N_bags.

This module fits 30 GradientBoostingRegressors with loss='quantile',
alpha=0.5 on bootstrap subsamples of 85% of the supervised rows.
The bag predictions are aggregated by:
    point  = median across 30 bag predictions
    lo80   = 10th percentile across bags (empirical interval)
    hi80   = 90th percentile across bags

The proven-good pattern from `strategies/agent_v_bootquantile.py` —
sub-sample-with-replacement at 85%, per-bag random_state, percentile
intervals from the bag distribution — is reused here on top of the
nowcast supervised builder (`_build_supervised`) so feature
engineering stays identical to the quantile baseline.

Each cut is wrapped in try/except, with a fallback to a plain
`nowcast_quantile` fit in case the bag pipeline blows up.

Budget: 30 GBR(n_estimators=200, depth=3) fits per cut, well under
60s on the 24-month walk-forward (vs 50 fits/horizon for the multi-
horizon Agent V).
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
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at
from .nowcast_quantile import (
    _build_inference_features,
    _mom_to_yoy,
    fit_quantile_nowcast_model,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_N_BAGS = 30
_BAG_FRAC = 0.85
_RANDOM_STATE = 42

_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval to avoid collapse

_GBR_PARAMS = dict(
    loss="quantile",
    alpha=0.5,
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
)


@dataclass
class BaggedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class BaggedNowcastModel:
    """30 bagged quantile-median GBRs over an aligned feature column list."""

    models: list[GradientBoostingRegressor]
    feature_cols: list[str]
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (median, lo10, hi90) of the bag-prediction distribution."""
        x_aligned = (
            x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        )
        preds = np.empty(len(self.models), dtype=float)
        for i, m in enumerate(self.models):
            try:
                preds[i] = float(m.predict(x_aligned)[0])
            except Exception:
                preds[i] = np.nan

        good = preds[np.isfinite(preds)]
        if good.size < 5:
            raise RuntimeError("bag predictions failed")

        median = float(np.median(good))
        lo = float(np.percentile(good, 10.0))
        hi = float(np.percentile(good, 90.0))

        # Re-anchor: percentile asymmetry can sometimes push lo above
        # median or hi below it (rare but happens with small N_BAGS on
        # heavy ties); enforce monotone ordering.
        if lo > median:
            lo = median - _RESID_FLOOR
        if hi < median:
            hi = median + _RESID_FLOOR
        return median, lo, hi


def fit_bagged_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> BaggedNowcastModel:
    """Fit 30 quantile-median GBRs on bootstrap subsamples of 85% of rows."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values.astype(float)
    yv = y.values.astype(float)
    n = len(yv)

    bag_size = max(1, int(np.floor(_BAG_FRAC * n)))
    rng = np.random.default_rng(_RANDOM_STATE)

    models: list[GradientBoostingRegressor] = []
    for b in range(_N_BAGS):
        # Bootstrap with replacement on row indices.
        idx = rng.choice(n, size=bag_size, replace=True)
        Xb = Xv[idx]
        yb = yv[idx]
        seed = int(rng.integers(0, 2**31 - 1))
        try:
            gbr = GradientBoostingRegressor(
                random_state=seed, **_GBR_PARAMS,
            ).fit(Xb, yb)
            models.append(gbr)
        except Exception:
            # Skip this bag; aggregation handles uneven counts gracefully.
            continue

    if len(models) < 5:
        raise RuntimeError("too few bags fit successfully")

    return BaggedNowcastModel(
        models=models, feature_cols=cols, as_of_day=as_of_day,
    )


def _floor_band(pred_yoy: float, lo80_yoy: float, hi80_yoy: float) -> tuple[float, float]:
    """Sanity floor on band half-width — keep some uncertainty even on tight fits."""
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR
    return lo80_yoy, hi80_yoy


def run_bagged_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> BaggedNowcastResult:
    """Pull live panels, fit bagged quantile model, produce a current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    try:
        model = fit_bagged_nowcast_model(panel, daily_frame, as_of_day=as_of_day)
    except Exception:
        # Fallback: plain single-quantile fit if bagging fails.
        qmodel = fit_quantile_nowcast_model(panel, daily_frame, as_of_day=as_of_day)
        return _run_via_quantile(panel, daily_frame, qmodel, as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
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

    try:
        pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    except Exception:
        qmodel = fit_quantile_nowcast_model(panel, daily_frame, as_of_day=as_of_day)
        return _run_via_quantile(panel, daily_frame, qmodel, as_of_day)

    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)
    lo80_yoy, hi80_yoy = _floor_band(pred_yoy, lo80_yoy, hi80_yoy)

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return BaggedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def _run_via_quantile(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    qmodel,
    as_of_day: int,
) -> BaggedNowcastResult:
    """Fallback path: re-use the plain quantile model on the live cut."""
    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
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

    pred_mom, lo_mom, hi_mom = qmodel.predict_one(pd.Series(feats))
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)
    lo80_yoy, hi80_yoy = _floor_band(pred_yoy, lo80_yoy, hi80_yoy)

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return BaggedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_bagged_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the bagged quantile nowcaster.

    For each cut t in the trailing `window_months`:
      - train 30 bagged GBR(quantile=0.5) on data strictly BEFORE t
      - predict t's MoM as the median of the 30 bag predictions
      - clip to [-1.5, 2.5], chain to YoY against published CPI

    On any exception during bag fitting/prediction, fall back to the
    plain single-quantile model for that cut so one bad cut doesn't
    nuke the whole window.

    Return shape mirrors `nowcast.backtest_nowcast` exactly.
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

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            # Try bagged path first; on any failure, fall back to the
            # plain quantile fit (which itself is wrapped).
            used_fallback = False
            try:
                model = fit_bagged_nowcast_model(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
            except Exception:
                model = fit_quantile_nowcast_model(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
                used_fallback = True

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day,
            )

            try:
                pred_mom, _, _ = model.predict_one(pd.Series(feats))
            except Exception:
                if used_fallback:
                    raise
                model = fit_quantile_nowcast_model(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
                pred_mom, _, _ = model.predict_one(pd.Series(feats))

            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
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
