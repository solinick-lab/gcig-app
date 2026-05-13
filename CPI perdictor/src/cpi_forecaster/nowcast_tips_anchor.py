"""TIPS-anchored quantile CPI nowcaster.

The pure quantile nowcaster (`nowcast_quantile.py`) treats T5YIE / T10YIE
as just two more features in a wide bag of daily indicators. But the bond
market's expectation of inflation isn't merely correlated noise — it's a
priced, money-on-the-line forecast. This module elevates that signal:

1. From the supervised training panel, fit a SIMPLE Ridge:
       y_yoy_lag1 ≈ alpha + beta * T5YIE  (+ T10YIE as a partner)
   This yields a "TIPS-implied YoY" estimator. We project it into a
   "TIPS-implied current-month MoM" by chaining: take the implied YoY,
   subtract last-12-month MoM cumulative, scale to one-month.
2. Add `tips_anchor_yoy` and `tips_anchor_mom` as STRONG, hand-crafted
   features alongside the rest of the daily/monthly stack.
3. Fit three quantile-loss GBRs at q={0.1, 0.5, 0.9} on the augmented X.
4. Sort the predicted triple to enforce monotonicity, clip MoM to a
   sane band, and chain to YoY using the same logic as the baseline.

The hope: the GBR uses the anchor as a strong prior and only adjusts in
months where bond markets have visibly mispriced reality (i.e., shock
months — Feb 2022, Mar 2020). Across the rest, the anchor pulls the
median toward what TIPS already imply.

Reuses `_build_supervised` from `nowcast.py` and `_as_of_for_month`,
DEFAULT_AS_OF_DAY for timing parity. One bad cut won't tank the backtest.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Ridge

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
_RESID_FLOOR = 0.05  # min half-width on YoY interval

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Which TIPS features in the supervised X carry the bond-market signal.
# `_mtd_pct` is the level-shift relative to prior-month avg. We also use
# the level itself (`_latest`) when available; in our feature set the
# closest analogue is `_mtd_pct` plus `_completeness`. We'll synthesize
# a level-like proxy from the daily frame at the same as_of.
_TIPS_5Y = "T5YIE"
_TIPS_10Y = "T10YIE"


@dataclass
class TipsAnchorNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class TipsAnchorNowcastModel:
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]
    anchor_alpha: float
    anchor_beta_5y: float
    anchor_beta_10y: float
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Sorted triple: (median, lo10, hi90)."""
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = [float(self.models[q].predict(x_aligned)[0]) for q in _QUANTILES]
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


# --- TIPS anchor helpers --------------------------------------------

def _tips_level_at(daily_frame: dict[str, pd.Series], as_of: pd.Timestamp, sid: str) -> float:
    """Most recent TIPS BEI value at or before `as_of` (in % YoY space).

    NaN if the series isn't present or has no observations yet.
    """
    s = daily_frame.get(sid)
    if s is None or len(s) == 0:
        return float("nan")
    recent = s.loc[s.index <= as_of]
    if len(recent) == 0:
        return float("nan")
    return float(recent.iloc[-1])


def _build_tips_anchor_features(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of: pd.Timestamp,
) -> tuple[float, float]:
    """Return (tips_5y_level, tips_10y_level) at `as_of`."""
    return (
        _tips_level_at(daily_frame, as_of, _TIPS_5Y),
        _tips_level_at(daily_frame, as_of, _TIPS_10Y),
    )


def _fit_tips_anchor_ridge(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> tuple[float, float, float]:
    """Fit y_yoy_lag1 ≈ alpha + beta_5y * T5YIE + beta_10y * T10YIE.

    Uses each historical month's "as-of day N" TIPS reading paired with
    that month's realized YoY. Handles missing TIPS gracefully (alpha=0,
    betas=0 fallback so the anchor degenerates to NaN-safe zeros).
    """
    cpi = panel[TARGET.fred_id].dropna()
    if len(cpi) < 26:
        return 0.0, 0.0, 0.0

    rows: list[tuple[float, float, float]] = []  # (t5, t10, yoy_realized)
    # Walk each month with at least 13 months of CPI history.
    for i in range(13, len(cpi)):
        month_end = cpi.index[i]
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        t5, t10 = _build_tips_anchor_features(panel, daily_frame, as_of)
        if not (np.isfinite(t5) or np.isfinite(t10)):
            continue
        # Realized YoY for this month.
        yoy = (cpi.iloc[i] / cpi.iloc[i - 12] - 1.0) * 100.0
        if not np.isfinite(yoy):
            continue
        rows.append((t5 if np.isfinite(t5) else np.nan,
                     t10 if np.isfinite(t10) else np.nan,
                     float(yoy)))

    if len(rows) < 24:
        return 0.0, 0.0, 0.0

    arr = np.array(rows, dtype=float)
    # Median-impute missing TIPS columns so Ridge can fit.
    for col in (0, 1):
        col_vals = arr[:, col]
        if np.any(~np.isfinite(col_vals)):
            med = np.nanmedian(col_vals) if np.any(np.isfinite(col_vals)) else 0.0
            col_vals = np.where(np.isfinite(col_vals), col_vals, med)
            arr[:, col] = col_vals

    X_anchor = arr[:, :2]
    y_anchor = arr[:, 2]
    try:
        ridge = Ridge(alpha=1.0).fit(X_anchor, y_anchor)
    except Exception:
        return 0.0, 0.0, 0.0
    alpha = float(ridge.intercept_)
    beta_5y = float(ridge.coef_[0])
    beta_10y = float(ridge.coef_[1])
    return alpha, beta_5y, beta_10y


def _augment_with_anchor(
    X: pd.DataFrame,
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    alpha: float,
    beta_5y: float,
    beta_10y: float,
) -> pd.DataFrame:
    """Add `tips_anchor_yoy` and `tips_anchor_mom_proxy` columns.

    For each training row indexed at `month_end`:
      tips_anchor_yoy = alpha + beta_5y * T5YIE_lag + beta_10y * T10YIE_lag
      tips_anchor_mom_proxy = tips_anchor_yoy / 12  (rough monthly slice)
    `_lag` here means the TIPS reading at as_of-day-N of the target month —
    same as how features_at() consumes the daily frame.
    """
    cpi = panel[TARGET.fred_id].dropna()
    anchor_yoy_vals: list[float] = []
    anchor_mom_vals: list[float] = []
    for month_end in X.index:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        t5, t10 = _build_tips_anchor_features(panel, daily_frame, as_of)
        # Median-impute at use time too.
        if not np.isfinite(t5):
            t5 = 0.0
        if not np.isfinite(t10):
            t10 = 0.0
        yoy_pred = alpha + beta_5y * t5 + beta_10y * t10
        anchor_yoy_vals.append(float(yoy_pred))
        anchor_mom_vals.append(float(yoy_pred / 12.0))
    X = X.copy()
    X["tips_anchor_yoy"] = anchor_yoy_vals
    X["tips_anchor_mom_proxy"] = anchor_mom_vals
    return X


# --- model fit / inference ------------------------------------------

def fit_tips_anchor_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> TipsAnchorNowcastModel:
    """Fit anchor Ridge, then three quantile GBRs on augmented X."""
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    alpha, beta_5y, beta_10y = _fit_tips_anchor_ridge(panel, daily_frame, as_of_day)
    X_aug = _augment_with_anchor(
        X, panel, daily_frame, as_of_day, alpha, beta_5y, beta_10y,
    )
    cols = list(X_aug.columns)
    Xv = X_aug.values
    yv = y.values

    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr

    return TipsAnchorNowcastModel(
        models=models,
        feature_cols=cols,
        anchor_alpha=alpha,
        anchor_beta_5y=beta_5y,
        anchor_beta_10y=beta_10y,
        as_of_day=as_of_day,
    )


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
    model: TipsAnchorNowcastModel,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Inference-time feature row, including the TIPS anchor columns."""
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
    # Anchor columns
    t5, t10 = _build_tips_anchor_features(daily_frame=daily_frame, as_of=as_of, panel=train_panel)
    if not np.isfinite(t5):
        t5 = 0.0
    if not np.isfinite(t10):
        t10 = 0.0
    yoy_pred = model.anchor_alpha + model.anchor_beta_5y * t5 + model.anchor_beta_10y * t10
    feats["tips_anchor_yoy"] = float(yoy_pred)
    feats["tips_anchor_mom_proxy"] = float(yoy_pred / 12.0)
    return feats, as_of


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    """Standard chain: predicted_cpi = last_cpi * exp(mom/100); divide
    by CPI 12 months prior to target_month."""
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


def run_tips_anchor_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> TipsAnchorNowcastResult:
    """Live inference: fetch panels, fit, predict current month."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_tips_anchor_model(panel, daily_frame, as_of_day=as_of_day)

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
    # Anchor at inference
    t5, t10 = _build_tips_anchor_features(daily_frame=daily_frame, as_of=as_of, panel=panel)
    if not np.isfinite(t5):
        t5 = 0.0
    if not np.isfinite(t10):
        t10 = 0.0
    yoy_pred = model.anchor_alpha + model.anchor_beta_5y * t5 + model.anchor_beta_10y * t10
    feats["tips_anchor_yoy"] = float(yoy_pred)
    feats["tips_anchor_mom_proxy"] = float(yoy_pred / 12.0)

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

    return TipsAnchorNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_tips_anchor_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the TIPS-anchored quantile nowcaster.

    For each cut t in trailing `window_months`:
      - train on data strictly BEFORE t (refits anchor Ridge inside)
      - predict t's MoM at q={0.1, 0.5, 0.9}, sort -> median
      - clip to [-1.5, 2.5], chain to YoY against published CPI 12 mo prior

    Try/except around each cut so a single failure can't kill the run.
    Output schema matches `nowcast.backtest_nowcast`.
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

            model = fit_tips_anchor_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features(
                train_panel, daily_frame, target_month_end, as_of_day, model,
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
