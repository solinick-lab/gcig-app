"""Within-month feature builder for the CPI nowcaster.

The fundamental nowcasting trick: by the 20th of a month, you've already
observed ~2/3 of the month's daily price movements. A model that uses
"WTI average through day 20 of current month" sees information the
month-ahead forecaster (which only has prior-month aggregates) cannot.

This module turns the raw daily panel into FEATURES that represent the
state of the current (partial) month at any "as-of date":

Per daily series:
  - Month-to-date average level
  - Month-to-date % change vs prior-month average
  - Last-7-day % change
  - Days observed in current month (how complete is the partial signal)

Per weekly series:
  - Most recent reading
  - 4-week average
  - 4-week % change

The output is a feature DataFrame indexed by simulated as-of dates, so
the same code generates training rows (historical "as-of day 20 of month
T_train") and the live inference row (today, partial through current month).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# Series we treat as DAILY in the panel.
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

# Series we treat as WEEKLY.
_WEEKLY_IDS = (
    "GASREGW",
    "GASDESW",
    "ICSA",
)


def build_daily_frame(daily_panel: dict) -> dict[str, pd.Series]:
    """Convert the daily-panel JSON into per-series pandas Series indexed
    by date. Skips any series not in the response."""
    out: dict[str, pd.Series] = {}
    for sid in _DAILY_IDS:
        records = daily_panel.get("daily", {}).get(sid)
        if not records:
            continue
        idx = pd.to_datetime([r["date"] for r in records])
        vals = np.array([r["value"] for r in records], dtype=float)
        s = pd.Series(vals, index=idx, name=sid).sort_index()
        out[sid] = s
    for sid in _WEEKLY_IDS:
        records = daily_panel.get("weekly", {}).get(sid)
        if not records:
            continue
        idx = pd.to_datetime([r["date"] for r in records])
        vals = np.array([r["value"] for r in records], dtype=float)
        s = pd.Series(vals, index=idx, name=sid).sort_index()
        out[sid] = s
    return out


def _month_start(ts: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(year=ts.year, month=ts.month, day=1)


def _prior_month_avg(s: pd.Series, as_of: pd.Timestamp) -> float:
    """Average of `s` over the calendar month immediately before `as_of`."""
    this_start = _month_start(as_of)
    prior_end = this_start - pd.Timedelta(days=1)
    prior_start = _month_start(prior_end)
    window = s.loc[(s.index >= prior_start) & (s.index <= prior_end)]
    if len(window) == 0:
        return np.nan
    return float(window.mean())


def _mtd_avg(s: pd.Series, as_of: pd.Timestamp) -> float:
    """Average of `s` from start of `as_of`'s month through `as_of`."""
    start = _month_start(as_of)
    window = s.loc[(s.index >= start) & (s.index <= as_of)]
    if len(window) == 0:
        return np.nan
    return float(window.mean())


def _mtd_count(s: pd.Series, as_of: pd.Timestamp) -> int:
    start = _month_start(as_of)
    window = s.loc[(s.index >= start) & (s.index <= as_of)]
    return int(len(window))


def _last_n_days_pct_change(s: pd.Series, as_of: pd.Timestamp, n: int) -> float:
    """Percent change between (as_of - n days, as_of) windows."""
    end = as_of
    mid = end - pd.Timedelta(days=n)
    start = mid - pd.Timedelta(days=n)
    recent = s.loc[(s.index > mid) & (s.index <= end)]
    prior = s.loc[(s.index > start) & (s.index <= mid)]
    if len(recent) == 0 or len(prior) == 0:
        return np.nan
    r = float(recent.mean())
    p = float(prior.mean())
    if not np.isfinite(r) or not np.isfinite(p) or p == 0:
        return np.nan
    return (r / p - 1.0) * 100.0


def features_at(daily_frame: dict[str, pd.Series], as_of: pd.Timestamp) -> dict[str, float]:
    """Compute the within-month feature dict for one as-of date.

    The features capture: where is each series RIGHT NOW vs prior month,
    plus near-term momentum, plus how complete the partial month is
    (so the model can learn that day-25 features are more reliable than
    day-5 features).
    """
    feats: dict[str, float] = {}

    for sid, s in daily_frame.items():
        if sid not in _DAILY_IDS:
            continue
        prior = _prior_month_avg(s, as_of)
        mtd = _mtd_avg(s, as_of)
        mtd_n = _mtd_count(s, as_of)
        last7 = _last_n_days_pct_change(s, as_of, 7)
        # Month-to-date % change vs prior month avg
        if np.isfinite(prior) and np.isfinite(mtd) and prior != 0:
            mtd_pct = (mtd / prior - 1.0) * 100.0
        else:
            mtd_pct = np.nan
        feats[f"{sid}_mtd_pct"] = mtd_pct
        feats[f"{sid}_last7_pct"] = last7
        # Cap mtd_n at 31; then a simple "completeness" fraction.
        feats[f"{sid}_completeness"] = min(mtd_n, 31) / 31.0

    for sid, s in daily_frame.items():
        if sid not in _WEEKLY_IDS:
            continue
        # Last observation up to as_of
        recent = s.loc[s.index <= as_of]
        if len(recent) == 0:
            feats[f"{sid}_latest"] = np.nan
            feats[f"{sid}_4wk_pct"] = np.nan
            continue
        latest = float(recent.iloc[-1])
        last4 = recent.iloc[-4:]
        prior4 = recent.iloc[-8:-4] if len(recent) >= 8 else None
        feats[f"{sid}_latest"] = latest
        if prior4 is not None and len(prior4) > 0:
            r = float(last4.mean())
            p = float(prior4.mean())
            feats[f"{sid}_4wk_pct"] = (r / p - 1.0) * 100.0 if p != 0 else np.nan
        else:
            feats[f"{sid}_4wk_pct"] = np.nan

    return feats


def build_nowcast_features(
    daily_frame: dict[str, pd.Series],
    as_of_dates: list[pd.Timestamp],
) -> pd.DataFrame:
    """Build a feature DataFrame across many as-of dates.

    `as_of_dates` are the simulated nowcast dates — for training, typically
    "day 20 of each historical month"; for inference, just [today].
    """
    rows = []
    for d in as_of_dates:
        f = features_at(daily_frame, d)
        f["as_of"] = d
        rows.append(f)
    df = pd.DataFrame(rows).set_index("as_of")
    return df
