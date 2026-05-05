from __future__ import annotations

import logging
from datetime import date, timedelta

import duckdb
import pandas as pd

logger = logging.getLogger(__name__)

DEFAULT_SYMBOLS = ["BZ=F", "CL=F", "USO", "XLE"]


def refresh_prices(
    con: duckdb.DuckDBPyConnection,
    *,
    symbols: list[str] | None = None,
    yf_module=None,
    start: date | None = None,
    end: date | None = None,
) -> int:
    if yf_module is None:
        import yfinance as yf_module  # type: ignore
    syms = symbols or DEFAULT_SYMBOLS
    end = end or (date.today() + timedelta(days=1))
    start = start or (date.today() - timedelta(days=365 * 2))

    n = 0
    for sym in syms:
        df = yf_module.download(sym, start=start, end=end, progress=False, auto_adjust=False)
        if df is None or df.empty:
            logger.warning("no data for %s", sym)
            continue
        for ts, row in df.iterrows():
            d = pd.Timestamp(ts).date()
            close = float(row["Close"]) if not pd.isna(row["Close"]) else None
            adj = float(row["Adj Close"]) if "Adj Close" in row and not pd.isna(row["Adj Close"]) else close
            con.execute(
                "INSERT INTO prices_daily (date, symbol, close, adj_close) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (date, symbol) DO UPDATE SET close=excluded.close, adj_close=excluded.adj_close",
                [d, sym, close, adj],
            )
            n += 1
    return n
