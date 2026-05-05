from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

import duckdb


def collect_health(con: duckdb.DuckDBPyConnection) -> dict:
    last = con.execute("SELECT MAX(ts) FROM ais_messages").fetchone()[0]
    msg_count = con.execute("SELECT COUNT(*) FROM ais_messages").fetchone()[0]
    by_day = con.execute(
        "SELECT date, COUNT(*) FROM ais_messages "
        "WHERE ts >= CURRENT_DATE - INTERVAL '7' DAY "
        "GROUP BY date ORDER BY date"
    ).fetchall()
    gap_count_7d = con.execute(
        "SELECT COUNT(*) FROM collector_gaps "
        "WHERE gap_end >= CURRENT_TIMESTAMP - INTERVAL '7' DAY"
    ).fetchone()[0]
    return {
        "last_msg_ts": last,
        "msg_count": msg_count,
        "by_day_last_7": [(str(d), n) for d, n in by_day],
        "gap_count_7d": gap_count_7d,
    }


def db_size_mb(path: Path) -> float:
    return path.stat().st_size / (1024 * 1024) if path.exists() else 0.0
