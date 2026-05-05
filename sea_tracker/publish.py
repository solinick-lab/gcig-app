"""Thin wrapper around api_client. Kept separate from cli.py so the
typer command bodies stay readable and so tests can monkeypatch a
single import target."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import duckdb

from sea_tracker.api_client import post_signals as _post_signals
from sea_tracker.api_client import post_snapshot as _post_snapshot
from sea_tracker.snapshot import build_snapshot


def publish_signals_window(con: duckdb.DuckDBPyConnection, *, days: int) -> dict:
    """Read signals_daily for the last `days` and POST them in one call."""
    cutoff = datetime.now(timezone.utc).date() - timedelta(days=days)
    rows = con.execute(
        "SELECT date, signal_name, value FROM signals_daily WHERE date >= ? ORDER BY date",
        [cutoff],
    ).fetchall()
    payload = [
        {"date": d.isoformat(), "name": name, "value": value}
        for d, name, value in rows
    ]
    return _post_signals(payload)


def publish_snapshot_now(
    con: duckdb.DuckDBPyConnection,
    *,
    bbox: tuple[float, float, float, float],
    now,
) -> dict:
    snap = build_snapshot(con, bbox=bbox, now=now)
    payload: dict[str, Any] = {
        "snapshotAt": now.isoformat() + "Z",
        "vesselCount": len(snap["vessels"]),
        "payload": snap,
    }
    return _post_snapshot(payload)
