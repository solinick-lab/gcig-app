"""Quantile_rich + alternative-CPI features.

The Cleveland Fed publishes a daily inflation nowcast directly. They also
publish median CPI and 16% trimmed-mean — these are smoothed inflation
measures. The Atlanta Fed publishes sticky CPI (slow-moving prices only).

All three are ALREADY in our gcig-api monthly panel via EXTRA_SERIES:
  - MEDCPIM158SFRBCLE   (Cleveland median CPI)
  - TRMMEANCPIM158SFRBCLE (Cleveland trimmed mean)
  - STICKCPIM157SFRBATL  (Atlanta sticky CPI)

Strategy: take the proven quantile_rich base and ADD lagged features from
these alternative measures. They give the model a smoothed view of
underlying inflation that complements the noisy daily features.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .nowcast import _build_supervised, _as_of_for_month, DEFAULT_AS_OF_DAY, NowcastResult
from .nowcast_features import features_at, build_daily_frame
from .nowcast_richfeats import rich_features_at
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel


# Series IDs in the monthly panel. Some may be missing for older cuts.
_ALT_CPI = {
    "med": "MEDCPIM158SFRBCLE",
    "trim": "TRMMEANCPIM158SFRBCLE",
    "sticky": "STICKCPIM157SFRBATL",
}


def _alt_features(panel: pd.DataFrame, target_month_end: pd.Timestamp) -> dict:
    """Build alt-CPI features as of `target_month_end - 1 month` (last released)."""
    feats = {}
    last_released = target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
    last_released = last_released + pd.offsets.MonthEnd(0)
    for label, sid in _ALT_CPI.items():
        if sid not in panel.columns:
            continue
        s = panel[sid].dropna()
        if len(s) < 14 or s.index[-1] < last_released - pd.Timedelta(days=45):
            continue
        # Last available value as of last_released
        prior = s.loc[s.index <= last_released]
        if len(prior) < 13:
            continue
        latest = float(prior.iloc[-1])
        prior_mom = float((prior.iloc[-1] / prior.iloc[-2] - 1.0) * 100.0) if prior.iloc[-2] != 0 else 0.0
        prior_yoy = float((prior.iloc[-1] / prior.iloc[-13] - 1.0) * 100.0) if prior.iloc[-13] != 0 else 0.0
        # 3mo moving avg of MoM (smoothed momentum)
        if len(prior) >= 5:
            moms = (prior.iloc[-3:].values / prior.iloc[-4:-1].values - 1.0) * 100.0
            avg3 = float(np.mean(moms))
        else:
            avg3 = prior_mom
        feats[f"{label}_yoy"] = prior_yoy
        feats[f"{label}_mom"] = prior_mom
        feats[f"{label}_3mo_mean_mom"] = avg3
    # Headline-vs-median wedge (a noise-component proxy)
    if "med_yoy" in feats:
        cpi = panel[TARGET.fred_id].dropna()
        prior_cpi = cpi.loc[cpi.index <= last_released]
        if len(prior_cpi) >= 13:
            head_yoy = float((prior_cpi.iloc[-1] / prior_cpi.iloc[-13] - 1.0) * 100.0)
            feats["head_minus_med"] = head_yoy - feats["med_yoy"]
    return feats


def _build_supervised_aug(panel, daily_frame, as_of_day):
    """Like nowcast._build_supervised but uses rich features + alt-CPI features."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible = y_mom.index[36:]
    rows, targets = [], []
    for month_end in eligible:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        feats.update(_alt_features(panel, month_end))
        feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
        if len(y_mom.loc[:month_end]) >= 3:
            feats["cpi_mom_lag2"] = float(y_mom.loc[:month_end].iloc[-3])
        else:
            feats["cpi_mom_lag2"] = np.nan
        if len(cpi.loc[:month_end]) >= 14:
            feats["cpi_yoy_lag1"] = float(
                (cpi.loc[:month_end].iloc[-2] / cpi.loc[:month_end].iloc[-14] - 1.0) * 100.0
            )
        else:
            feats["cpi_yoy_lag1"] = np.nan
        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))
    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    return df, y


def _fit_predict(X_train, y_train, x_inf):
    """Fit q={0.1, 0.5, 0.9} GBR on train, predict for the inference row."""
    preds = []
    for q in (0.1, 0.5, 0.9):
        m = GradientBoostingRegressor(
            loss="quantile", alpha=q, n_estimators=400,
            max_depth=3, learning_rate=0.05, random_state=42,
        ).fit(X_train.values, y_train.values)
        preds.append(float(m.predict(x_inf.values.reshape(1, -1))[0]))
    preds.sort()
    lo, mid, hi = preds
    mid = float(np.clip(mid, -1.5, 2.5))
    return mid, lo, hi


def _yoy_chain(panel, mom_mid, mom_lo, mom_hi, target_month_end):
    cpi = panel[TARGET.fred_id].dropna()
    last_cpi = float(cpi.iloc[-1])
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))

    def _to_yoy(mom):
        return (last_cpi * float(np.exp(mom / 100.0)) / denom - 1.0) * 100.0

    return _to_yoy(mom_mid), _to_yoy(mom_lo), _to_yoy(mom_hi)


def backtest_altcpi_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    cuts = list(range(len(y_mom) - window_months, len(y_mom)))

    rows = []
    pm_arr, am_arr, py_arr, ay_arr = [], [], [], []
    for ci in cuts:
        target_month_end = y_mom.index[ci]
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue
        try:
            X, y = _build_supervised_aug(train_panel, daily_frame, as_of_day)
        except Exception:
            continue
        if len(X) < 24:
            continue

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        feats = rich_features_at(daily_frame, as_of)
        feats.update(_alt_features(panel, target_month_end))
        train_y = build_target(train_panel).dropna()
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
        feats["cpi_yoy_lag1"] = float(
            (train_panel[TARGET.fred_id].dropna().iloc[-1]
             / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
        ) if len(train_panel[TARGET.fred_id].dropna()) >= 13 else np.nan
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

        # Align features to training columns
        x_inf = pd.Series(feats).reindex(X.columns).fillna(X.median(numeric_only=True))

        try:
            mid, lo, hi = _fit_predict(X, y, x_inf)
        except Exception:
            continue

        actual_mom = float(y_mom.iloc[ci])
        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        pred_cpi = last_cpi_train * float(np.exp(mid / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (pred_cpi / denom - 1.0) * 100.0
        actual_cpi = float(cpi.loc[target_month_end])
        actual_yoy = (actual_cpi / denom - 1.0) * 100.0

        pm_arr.append(mid); am_arr.append(actual_mom)
        py_arr.append(pred_yoy); ay_arr.append(actual_yoy)
        rows.append({
            "target_month": target_month_end.strftime("%Y-%m"),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "pred_mom": round(mid, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(pred_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(pred_yoy - actual_yoy, 3),
        })

    if not pm_arr:
        return {"error": "no successful cuts"}

    pm = np.array(pm_arr); am = np.array(am_arr)
    py = np.array(py_arr); ay = np.array(ay_arr)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(pm),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }


def run_altcpi_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    X, y = _build_supervised_aug(panel, daily_frame, as_of_day)
    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    feats.update(_alt_features(panel, target_month_end))
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    x_inf = pd.Series(feats).reindex(X.columns).fillna(X.median(numeric_only=True))
    mid, lo, hi = _fit_predict(X, y, x_inf)
    yoy_mid, yoy_lo, yoy_hi = _yoy_chain(panel, mid, lo, hi, target_month_end)

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=yoy_mid,
        lo80_yoy=yoy_lo,
        hi80_yoy=yoy_hi,
        days_observed=days_observed,
    )
