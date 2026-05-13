"""Monotonic-constrained quantile CPI nowcaster.

The pure quantile nowcaster (`nowcast_quantile.py`) lets each GBR find
its own feature-target relationship. On a small monthly panel that's
risky: the model can easily learn that a recent oil RALLY predicts CPI
DOWN simply because of one or two anomalous months in the training set.
That's an economic absurdity — oil is a direct cost-push input.

This variant encodes economic priors as MONOTONIC CONSTRAINTS on the
quantile GBRs. sklearn 1.4+ supports `monotonic_cst` on
GradientBoostingRegressor (and definitely on HistGradientBoostingRegressor,
which is the fallback path). Each constrained feature gets +1 (must
weakly increase the prediction) or 0 (no constraint). We use no -1
constraints in this feature set: UNRATE isn't part of the within-month
nowcast features, USD's sign on CPI is genuinely ambiguous (depends on
import share), and longer-horizon yields are forward-looking.

Constraint map (column-prefix based, applied to the names emitted by
`nowcast_features.features_at` + the monthly lag/calendar additions):
  +1: DCOILWTICO_*, DCOILBRENTEU_*, GASREGW_*, GASDESW_*,
      T5YIE_*, T10YIE_*, T5YIFR_*    (energy + breakeven inflation)
   0: everything else (CPI lags, calendar, USD, yields, IP-style,
      completeness counters, etc.)

Standard quantile triple at alpha={0.1, 0.5, 0.9}; sort to fix any
crossings; clip MoM to [-1.5, 2.5] before the YoY chain. One bad cut
gets try/except'd so the 24-month walk-forward survives.

Falls back automatically to HistGradientBoostingRegressor if the
installed sklearn version doesn't support `monotonic_cst` on the
classic GBR (added in 1.4 — the histogram variant has had it longer).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

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
_RESID_FLOOR = 0.05  # minimum half-width on YoY interval

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Hist-GBR fallback — uses max_iter / max_leaf_nodes instead of n_estimators / max_depth.
_HGBR_PARAMS = dict(
    max_iter=400,
    max_leaf_nodes=15,        # ~depth-3 budget
    learning_rate=0.05,
    random_state=42,
    early_stopping=False,
)

# FRED IDs whose features should monotonically PUSH CPI UP (cost-push channels).
# Anything not listed gets a 0 (no constraint). We deliberately use no -1 in
# this feature set: USD/yields are ambiguous, UNRATE is not in the within-month
# panel, and shelter is a target component (leakage as a constraint).
_POS_PREFIXES: tuple[str, ...] = (
    "DCOILWTICO",   # WTI Oil — direct energy cost-push.
    "DCOILBRENTEU", # Brent — same channel as WTI.
    "GASREGW",      # Retail gas — feeds CPI energy line directly.
    "GASDESW",      # Diesel — pipeline cost-push (food, transport).
    "T5YIE",        # 5Y breakeven inflation expectation.
    "T10YIE",       # 10Y breakeven inflation expectation.
    "T5YIFR",       # 5Y5Y forward breakeven.
)


def _constraint_for_column(col: str) -> int:
    """Return +1/0 for a feature column based on prefix.

    Columns from `features_at`:
      - <SID>_mtd_pct   : month-to-date % change vs prior-month avg
      - <SID>_last7_pct : last-7-day % change
      - <SID>_completeness : 0..1 fraction (NOT a directional signal — leave 0)
      - <SID>_latest    : weekly latest (level, but we constrain anyway —
                          higher gas price -> higher CPI is a level relationship)
      - <SID>_4wk_pct   : weekly 4-week % change
    Plus monthly add-ons: cpi_mom_lag1, cpi_mom_lag2, cpi_yoy_lag1,
    month_sin, month_cos — all unconstrained.
    """
    # Completeness counters are coverage indicators, not directional — never constrain.
    if col.endswith("_completeness"):
        return 0
    # CPI lags: autoregressive, sign genuinely ambiguous (mean-reversion vs persistence).
    if col.startswith("cpi_"):
        return 0
    # Calendar terms: cyclical; either sign is valid depending on month.
    if col in ("month_sin", "month_cos"):
        return 0
    for prefix in _POS_PREFIXES:
        if col.startswith(prefix + "_"):
            return +1
    return 0


def _build_monotonic_array(feature_cols: list[str]) -> np.ndarray:
    """Construct the int8 monotonic_cst vector aligned to `feature_cols`."""
    return np.array(
        [_constraint_for_column(c) for c in feature_cols],
        dtype=np.int8,
    )


@dataclass
class MonotonicNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class MonotonicNowcastModel:
    models: dict          # alpha -> fitted regressor
    feature_cols: list[str]
    monotonic_cst: np.ndarray
    as_of_day: int
    backend: str          # "gbr" or "hgbr"

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (median, lo10, hi90); sort to repair quantile crossings."""
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = [float(self.models[q].predict(x_aligned)[0]) for q in _QUANTILES]
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


def _fit_quantile_regressor(
    Xv: np.ndarray,
    yv: np.ndarray,
    alpha: float,
    monotonic_cst: np.ndarray,
):
    """Fit ONE quantile regressor with monotonic constraints.

    Tries GradientBoostingRegressor (sklearn 1.4+) first. If that
    rejects `monotonic_cst` (older sklearn), falls back to
    HistGradientBoostingRegressor which has supported it longer.
    """
    from sklearn.ensemble import (
        GradientBoostingRegressor,
        HistGradientBoostingRegressor,
    )

    # Try classic GBR first — same hyperparams as the unconstrained variant.
    try:
        gbr = GradientBoostingRegressor(
            loss="quantile",
            alpha=alpha,
            monotonic_cst=monotonic_cst,
            **_GBR_PARAMS,
        )
        gbr.fit(Xv, yv)
        return gbr, "gbr"
    except TypeError:
        # sklearn < 1.4 — `monotonic_cst` is an unknown kwarg.
        pass
    except Exception:
        # Some other sklearn issue with the constrained fit; fall through.
        pass

    # Fallback: HistGradientBoostingRegressor (constraints supported earlier).
    hgbr = HistGradientBoostingRegressor(
        loss="quantile",
        quantile=alpha,
        monotonic_cst=monotonic_cst,
        **_HGBR_PARAMS,
    )
    hgbr.fit(Xv, yv)
    return hgbr, "hgbr"


def fit_monotonic_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> MonotonicNowcastModel:
    """Fit three monotonic-constrained quantile regressors on (X, y)."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    monotonic_cst = _build_monotonic_array(cols)
    assert len(monotonic_cst) == Xv.shape[1]

    models: dict = {}
    backend = "gbr"
    for q in _QUANTILES:
        model, used = _fit_quantile_regressor(Xv, yv, q, monotonic_cst)
        models[q] = model
        backend = used  # all three should land on the same backend

    return MonotonicNowcastModel(
        models=models,
        feature_cols=cols,
        monotonic_cst=monotonic_cst,
        as_of_day=as_of_day,
        backend=backend,
    )


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Mirror of nowcast_quantile._build_inference_features."""
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
    """MoM log-% -> YoY % using the same chain as the baseline."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


def run_monotonic_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> MonotonicNowcastResult:
    """Live: fetch panels, fit constrained quantile model, nowcast current month."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_monotonic_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

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

    return MonotonicNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_monotonic_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the monotonic-constrained quantile nowcaster.

    Same shape and conventions as `nowcast_quantile.backtest_quantile_nowcast`:
      - For each target_month in the trailing `window_months`,
      - Fit three constrained quantile regressors on data BEFORE that month,
      - Predict its MoM, sort the q-triple, take the median,
      - Clip MoM to [-1.5, 2.5], chain to YoY,
      - Skip individual cuts that fail (insufficient history, etc.).

    Output schema mirrors `nowcast.backtest_nowcast` exactly so the
    runner can drop this in alongside the other agents.
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

            model = fit_monotonic_nowcast_model(
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
            # One bad cut shouldn't kill the whole walk-forward.
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
