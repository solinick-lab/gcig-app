from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Protocol

from sea_tracker.db import (
    batch_insert_messages,
    connect,
    init_schema,
    last_message_ts,
    mark_gap,
    upsert_vessel,
)
from sea_tracker.normalize import normalize_message

logger = logging.getLogger(__name__)


class Streamer(Protocol):
    def stream(self) -> AsyncIterator[dict[str, Any]]: ...


async def run_collector(
    client: Streamer,
    db_path: Path | str,
    *,
    flush_interval_s: float = 1.0,
    max_messages: int | None = None,
) -> None:
    """Pump messages from `client.stream()` into DuckDB. Runs forever unless
    `max_messages` is set (used by tests)."""
    con = connect(db_path)
    init_schema(con)

    last_seen = last_message_ts(con)
    if last_seen is not None:
        mark_gap(con, last_seen + timedelta(seconds=1), datetime.utcnow(), "restart")

    buffer_msgs: list[dict[str, Any]] = []
    buffer_vessels: list[dict[str, Any]] = []
    last_flush = asyncio.get_event_loop().time()
    seen = 0

    try:
        async for payload in client.stream():
            norm = normalize_message(payload)
            if norm is not None:
                buffer_msgs.append(norm.message_row)
                if norm.vessel_update is not None:
                    buffer_vessels.append(norm.vessel_update)
                seen += 1

            now = asyncio.get_event_loop().time()
            if (now - last_flush) >= flush_interval_s or seen >= 5000:
                if buffer_msgs:
                    batch_insert_messages(con, buffer_msgs)
                    buffer_msgs.clear()
                for v in buffer_vessels:
                    upsert_vessel(con, **v)
                buffer_vessels.clear()
                last_flush = now

            if max_messages is not None and seen >= max_messages:
                break

        # final flush
        if buffer_msgs:
            batch_insert_messages(con, buffer_msgs)
        for v in buffer_vessels:
            upsert_vessel(con, **v)
    finally:
        con.close()
