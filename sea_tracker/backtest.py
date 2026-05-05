from __future__ import annotations

import logging

import duckdb
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def forward_returns(closes: pd.Series, *, horizon_days: int) -> pd.Series:
    """Close-to-close return from t to t+horizon. NaN at the tail."""
    return closes.shift(-horizon_days) / closes - 1.0


def _pearson(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson correlation of two 1-D arrays (no NaNs)."""
    a = a - a.mean()
    b = b - b.mean()
    denom = np.sqrt((a * a).sum() * (b * b).sum())
    if denom == 0:
        return float("nan")
    return float((a * b).sum() / denom)


def information_coefficient(signal: pd.Series, fwd_ret: pd.Series) -> float:
    """Spearman rank correlation (no scipy dependency)."""
    df = pd.concat([signal, fwd_ret], axis=1).dropna()
    if len(df) < 5:
        return float("nan")
    ra = df.iloc[:, 0].rank().to_numpy(dtype=float)
    rb = df.iloc[:, 1].rank().to_numpy(dtype=float)
    return _pearson(ra, rb)


def rolling_ic(signal: pd.Series, fwd_ret: pd.Series, *, window: int = 30) -> pd.Series:
    """Rolling Spearman IC, computed via correlation of rolling-rank series."""
    df = pd.concat([signal.rank(), fwd_ret.rank()], axis=1).dropna()
    df.columns = ["s", "r"]
    return df["s"].rolling(window).corr(df["r"])


def ic_stability(rolling_ic_series: pd.Series) -> float:
    """Mean / std of a rolling IC series (t-stat-like). NaN if insufficient data."""
    s = rolling_ic_series.dropna()
    if len(s) < 5 or s.std() == 0:
        return float("nan")
    return float(s.mean() / s.std())


def bucket_returns(signal: pd.Series, fwd_ret: pd.Series, *, n_buckets: int) -> pd.Series:
    """Mean forward return per signal-rank bucket."""
    df = pd.concat([signal, fwd_ret], axis=1).dropna()
    df.columns = ["s", "r"]
    if len(df) < n_buckets:
        return pd.Series(dtype=float)
    df["b"] = pd.qcut(df["s"].rank(method="first"), q=n_buckets, labels=False)
    return df.groupby("b")["r"].mean()


def long_short_pnl(
    signal: pd.Series, fwd_ret: pd.Series, *, n_buckets: int = 5, cost_bps: float = 5
) -> pd.Series:
    """Daily P&L of (long top bucket, short bottom bucket), equal-weight,
    daily rebalance, fixed-bps round-trip cost."""
    df = pd.concat([signal, fwd_ret], axis=1).dropna()
    df.columns = ["s", "r"]
    if len(df) < n_buckets:
        return pd.Series(dtype=float)
    df["b"] = pd.qcut(df["s"].rank(method="first"), q=n_buckets, labels=False)
    df["pos"] = 0.0
    df.loc[df["b"] == n_buckets - 1, "pos"] = 1.0
    df.loc[df["b"] == 0, "pos"] = -1.0
    cost = (cost_bps / 10000.0) * df["pos"].diff().abs().fillna(df["pos"].abs())
    return df["pos"] * df["r"] - cost


def load_signal(con: duckdb.DuckDBPyConnection, name: str) -> pd.Series:
    rows = con.execute(
        "SELECT date, value FROM signals_daily WHERE signal_name = ? ORDER BY date",
        [name],
    ).fetchall()
    return pd.Series(
        [r[1] for r in rows],
        index=pd.to_datetime([r[0] for r in rows]),
        name=name,
    )


def load_prices(con: duckdb.DuckDBPyConnection, symbol: str) -> pd.Series:
    rows = con.execute(
        "SELECT date, adj_close FROM prices_daily WHERE symbol = ? ORDER BY date",
        [symbol],
    ).fetchall()
    return pd.Series(
        [r[1] for r in rows],
        index=pd.to_datetime([r[0] for r in rows]),
        name=symbol,
    )


def gap_dates(con: duckdb.DuckDBPyConnection) -> set[pd.Timestamp]:
    rows = con.execute("SELECT gap_start, gap_end FROM collector_gaps").fetchall()
    out: set[pd.Timestamp] = set()
    for a, b in rows:
        for d in pd.date_range(pd.Timestamp(a).normalize(), pd.Timestamp(b).normalize()):
            out.add(d)
    return out


def run_backtest(
    con: duckdb.DuckDBPyConnection,
    *,
    signal_name: str,
    target: str = "BZ=F",
    horizons: tuple[int, ...] = (1, 5, 10, 21),
    cost_bps: float = 5,
) -> dict:
    signal = load_signal(con, signal_name)
    closes = load_prices(con, target)
    if signal.empty or closes.empty:
        return {"signal": signal_name, "target": target, "ic": {}, "pnl": {}, "buckets": {}}

    masked = gap_dates(con)
    signal = signal[~signal.index.isin(masked)]
    aligned = signal.reindex(closes.index, method="ffill")

    ic = {}
    ic_stab = {}
    pnl = {}
    buckets = {}
    for h in horizons:
        fr = forward_returns(closes, horizon_days=h)
        ic[h] = information_coefficient(aligned, fr)
        ric = rolling_ic(aligned, fr)
        ic_stab[h] = ic_stability(ric)
        pnl[h] = long_short_pnl(aligned, fr, cost_bps=cost_bps)
        buckets[h] = bucket_returns(aligned, fr, n_buckets=5)

    return {
        "signal": signal_name, "target": target,
        "ic": ic, "ic_stability": ic_stab, "pnl": pnl, "buckets": buckets,
    }
