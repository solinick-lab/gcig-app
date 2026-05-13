"""MIDAS (Mixed Data Sampling) CPI nowcaster.

Real MIDAS aggregates daily series within the target month using
POLYNOMIAL-WEIGHTED lags rather than hand-coded features. This gives
the downstream learner a basis of weighted aggregations and lets it
pick which weighting scheme is most informative — without nonlinear
optimization of the polynomial parameters.

Five fixed weight schemes per daily series (within the target month):
  - uniform        : equal weights (mean) — same as MTD avg
  - linear_late    : k * v_k weighting — emphasizes late-month days
  - linear_early   : (K + 1 - k) * v_k weighting — emphasizes early days
  - exp_decay      : exp(-(K-k)/5) — heavy weight on the most recent day
  - beta_2_2       : ((k/K)*(1-k/K))^2 — emphasizes the middle of month

Each daily series produces 5 MIDAS-aggregated levels. We convert each
to a percent change vs. the prior month's mean (same series, same
weight scheme on the prior month) so the learner sees stationary
features. Combined with the rich-features set, monthly lags, and
calendar features. Three quantile GBRs (q={0.1, 0.5, 0.9}) — same head
shape as `nowcast_quantile_rich`. Standard MoM->YoY chain.

Same interface as `nowcast.backtest_nowcast` / `run_nowcast`.
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
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_DAILY_IDS = (
    "DCOILWTICO",
    "DCOILBRENTEU",
    "DTWEXBGS",
    "DGS10",
    "DGS2",
    "T10Y2Y",
    "T10Y3M",
    "T5YIE",
    "T10YIE",
    "T5YIFR",
    "BAMLH0A0HYM2",
)

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# MIDAS weight schemes — keys are stable suffixes for feature naming.
_MIDAS_SCHEMES = ("uniform", "lin_late", "lin_early", "exp_decay", "beta22")


@dataclass
class MidasNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class MidasNowcastModel:
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]
    as_of_day: int

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


# ---------------------------------------------------------------------
# MIDAS aggregation helpers
# ---------------------------------------------------------------------


def _midas_weights(K: int, scheme: str) -> np.ndarray:
    """Return a length-K weight vector summing to 1 for the given scheme.

    K is the number of observed days in the month (k = 1, ..., K).
    """
    if K <= 0:
        return np.zeros(0, dtype=float)
    k = np.arange(1, K + 1, dtype=float)
    if scheme == "uniform":
        w = np.ones(K, dtype=float)
    elif scheme == "lin_late":
        w = k.copy()
    elif scheme == "lin_early":
        w = (K + 1.0) - k
    elif scheme == "exp_decay":
        # Heavy weight on most recent day (k = K)
        w = np.exp(-(K - k) / 5.0)
    elif scheme == "beta22":
        # ((k/K)*(1-k/K))^2 — peaks in the middle. Avoid endpoints exactly 0.
        if K == 1:
            return np.array([1.0])
        # Use (k - 0.5)/K so endpoints don't collapse to 0 entirely.
        u = (k - 0.5) / K
        u = np.clip(u, 1e-6, 1.0 - 1e-6)
        w = (u * (1.0 - u)) ** 2
    else:
        w = np.ones(K, dtype=float)
    s = float(w.sum())
    if s <= 0 or not np.isfinite(s):
        return np.full(K, 1.0 / K)
    return w / s


def _month_daily_values(
    s: pd.Series,
    month_start: pd.Timestamp,
    as_of: pd.Timestamp,
) -> np.ndarray:
    """Daily values of s within [month_start, as_of], in date order.

    Uses business/calendar days that have observations — no forward-fill.
    Returns a 1-D float array (possibly empty).
    """
    if s is None or len(s) == 0:
        return np.zeros(0, dtype=float)
    win = s.loc[(s.index >= month_start) & (s.index <= as_of)]
    if len(win) == 0:
        return np.zeros(0, dtype=float)
    arr = win.values.astype(float)
    arr = arr[np.isfinite(arr)]
    return arr


def _midas_features_for_series(
    s: pd.Series,
    as_of: pd.Timestamp,
) -> dict[str, float]:
    """Compute the 5 MIDAS-weighted levels and their %-change vs prior month
    (same scheme on prior month). Returned keys: f"midas_{sid}_{scheme}_pct".

    The caller prefixes with the series ID.
    """
    out: dict[str, float] = {}
    month_start = pd.Timestamp(as_of.year, as_of.month, 1)
    prior_end = month_start - pd.Timedelta(days=1)
    prior_start = pd.Timestamp(prior_end.year, prior_end.month, 1)

    cur = _month_daily_values(s, month_start, as_of)
    pri = _month_daily_values(s, prior_start, prior_end)

    Kc = cur.shape[0]
    Kp = pri.shape[0]

    for scheme in _MIDAS_SCHEMES:
        if Kc == 0:
            cur_agg = np.nan
        else:
            wc = _midas_weights(Kc, scheme)
            cur_agg = float(np.dot(wc, cur))

        if Kp == 0:
            pri_agg = np.nan
        else:
            wp = _midas_weights(Kp, scheme)
            pri_agg = float(np.dot(wp, pri))

        # Percent change vs. prior-month aggregate
        if (
            np.isfinite(cur_agg)
            and np.isfinite(pri_agg)
            and pri_agg != 0
        ):
            out[f"{scheme}_pct"] = (cur_agg / pri_agg - 1.0) * 100.0
        else:
            out[f"{scheme}_pct"] = np.nan

        # Also include the raw level (helps for series like yields where
        # "level" matters more than ratio change). Caller can disregard.
        out[f"{scheme}_lvl"] = cur_agg if np.isfinite(cur_agg) else np.nan

    out["K_obs"] = float(Kc)
    return out


def midas_features_at(
    daily_frame: dict[str, pd.Series],
    as_of: pd.Timestamp,
) -> dict[str, float]:
    """Compute MIDAS features for all daily series at this as-of date."""
    feats: dict[str, float] = {}
    for sid in _DAILY_IDS:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            continue
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            continue
        try:
            mid = _midas_features_for_series(s_until, as_of)
        except Exception:
            continue
        for k, v in mid.items():
            feats[f"midas_{sid}_{k}"] = v
    return feats


def combined_features_at(
    daily_frame: dict[str, pd.Series],
    as_of: pd.Timestamp,
) -> dict[str, float]:
    """Concatenate rich features + MIDAS features."""
    feats = rich_features_at(daily_frame, as_of)
    midas = midas_features_at(daily_frame, as_of)
    feats.update(midas)
    return feats


# ---------------------------------------------------------------------
# Supervised dataset builder
# ---------------------------------------------------------------------


def _build_supervised_midas(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    eligible_months = y_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)

        try:
            feats = combined_features_at(daily_frame, as_of)
        except Exception:
            continue

        # Monthly CPI lags
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
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    if not rows:
        return pd.DataFrame(), pd.Series(dtype=float)

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------
# Model fit / inference
# ---------------------------------------------------------------------


def fit_midas_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> MidasNowcastModel:
    X, y = _build_supervised_midas(panel, daily_frame, as_of_day=as_of_day)
    if len(X) == 0:
        raise RuntimeError("No supervised rows for MIDAS fit")
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr

    return MidasNowcastModel(
        models=models,
        feature_cols=cols,
        as_of_day=as_of_day,
    )


def _build_inference_features_midas(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = combined_features_at(daily_frame, as_of)
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
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


# ---------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------


def run_midas_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> MidasNowcastResult:
    """Pull live panels, fit MIDAS model, produce a current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_midas_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = combined_features_at(daily_frame, as_of)
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

    return MidasNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_midas_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the MIDAS nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train three quantile GBRs on (rich + MIDAS) features strictly BEFORE t
      - predict t's MoM at q={0.1, 0.5, 0.9}, sort, take median
      - clip to [-1.5, 2.5], chain to YoY against published CPI 12m prior

    A single failed cut is skipped via try/except. Return shape mirrors
    `nowcast.backtest_nowcast`.
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

            model = fit_midas_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_features_midas(
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
