from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Iterable, TypedDict

import duckdb

SCHEMA_VERSION = 1


class MessageRow(TypedDict, total=False):
    ts: datetime
    mmsi: int
    msg_type: int
    lat: float | None
    lon: float | None
    sog: float | None
    cog: float | None
    heading: int | None
    nav_status: int | None
    draught_m: float | None
    raw: str


def connect(path: Path | str) -> duckdb.DuckDBPyConnection:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(p))


def init_schema(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("""
        CREATE TABLE IF NOT EXISTS schema_meta (
            version INTEGER PRIMARY KEY
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS ais_messages (
            ts          TIMESTAMP NOT NULL,
            mmsi        BIGINT NOT NULL,
            msg_type    SMALLINT NOT NULL,
            lat         DOUBLE,
            lon         DOUBLE,
            sog         DOUBLE,
            cog         DOUBLE,
            heading     SMALLINT,
            nav_status  SMALLINT,
            draught_m   DOUBLE,
            raw         JSON,
            ingest_ts   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            date        DATE GENERATED ALWAYS AS (CAST(ts AS DATE)),
            PRIMARY KEY (mmsi, ts, msg_type)
        );
    """)
    con.execute("CREATE INDEX IF NOT EXISTS idx_ais_date ON ais_messages(date);")
    con.execute("CREATE INDEX IF NOT EXISTS idx_ais_mmsi_ts ON ais_messages(mmsi, ts);")
    con.execute("""
        CREATE TABLE IF NOT EXISTS vessels (
            mmsi            BIGINT PRIMARY KEY,
            imo             BIGINT,
            name            TEXT,
            callsign        TEXT,
            ship_type       SMALLINT,
            length_m        INTEGER,
            beam_m          INTEGER,
            draught_m_max   DOUBLE,
            draught_m_min   DOUBLE,
            size_class      TEXT,
            first_seen      TIMESTAMP,
            last_seen       TIMESTAMP
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS transits (
            vessel_mmsi  BIGINT NOT NULL,
            crossing_ts  TIMESTAMP NOT NULL,
            direction    TEXT NOT NULL,
            laden         BOOLEAN,
            size_class   TEXT,
            ship_type    SMALLINT,
            PRIMARY KEY (vessel_mmsi, crossing_ts)
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS port_calls (
            vessel_mmsi  BIGINT NOT NULL,
            terminal     TEXT NOT NULL,
            enter_ts     TIMESTAMP NOT NULL,
            exit_ts      TIMESTAMP NOT NULL,
            dwell_hours  DOUBLE,
            PRIMARY KEY (vessel_mmsi, terminal, enter_ts)
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS signals_daily (
            date         DATE NOT NULL,
            signal_name  TEXT NOT NULL,
            value        DOUBLE,
            PRIMARY KEY (date, signal_name)
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS prices_daily (
            date       DATE NOT NULL,
            symbol     TEXT NOT NULL,
            close      DOUBLE,
            adj_close  DOUBLE,
            PRIMARY KEY (date, symbol)
        );
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS collector_gaps (
            gap_start         TIMESTAMP NOT NULL,
            gap_end           TIMESTAMP NOT NULL,
            detection_method  TEXT NOT NULL,
            PRIMARY KEY (gap_start, detection_method)
        );
    """)
    con.execute(
        "INSERT INTO schema_meta(version) VALUES (?) ON CONFLICT DO NOTHING",
        [SCHEMA_VERSION],
    )


def batch_insert_messages(
    con: duckdb.DuckDBPyConnection, rows: Iterable[MessageRow]
) -> int:
    rows = list(rows)
    if not rows:
        return 0
    payload = [
        (
            r["ts"], r["mmsi"], r["msg_type"], r.get("lat"), r.get("lon"),
            r.get("sog"), r.get("cog"), r.get("heading"), r.get("nav_status"),
            r.get("draught_m"), r.get("raw"),
        )
        for r in rows
    ]
    con.executemany(
        """
        INSERT INTO ais_messages
            (ts, mmsi, msg_type, lat, lon, sog, cog, heading, nav_status, draught_m, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (mmsi, ts, msg_type) DO NOTHING
        """,
        payload,
    )
    return len(payload)


def _naive_utc(ts: datetime) -> datetime:
    """Strip tzinfo, treating aware datetimes as UTC (store naive UTC in DB)."""
    if ts.tzinfo is not None:
        from datetime import timezone as _tz
        utc_ts = ts.astimezone(_tz.utc)
        return utc_ts.replace(tzinfo=None)
    return ts


def upsert_vessel(
    con: duckdb.DuckDBPyConnection,
    *,
    mmsi: int,
    imo: int | None,
    name: str | None,
    callsign: str | None,
    ship_type: int | None,
    length_m: int | None,
    beam_m: int | None,
    draught_m: float | None,
    ts: datetime,
) -> None:
    ts_naive = _naive_utc(ts)
    con.execute(
        """
        INSERT INTO vessels
            (mmsi, imo, name, callsign, ship_type, length_m, beam_m,
             draught_m_max, draught_m_min, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (mmsi) DO UPDATE SET
            imo            = COALESCE(excluded.imo, vessels.imo),
            name           = COALESCE(excluded.name, vessels.name),
            callsign       = COALESCE(excluded.callsign, vessels.callsign),
            ship_type      = COALESCE(excluded.ship_type, vessels.ship_type),
            length_m       = COALESCE(excluded.length_m, vessels.length_m),
            beam_m         = COALESCE(excluded.beam_m, vessels.beam_m),
            draught_m_max  = GREATEST(COALESCE(vessels.draught_m_max, excluded.draught_m_max), excluded.draught_m_max),
            draught_m_min  = LEAST(COALESCE(vessels.draught_m_min, excluded.draught_m_min), excluded.draught_m_min),
            last_seen      = GREATEST(vessels.last_seen, excluded.last_seen)
        """,
        [mmsi, imo, name, callsign, ship_type, length_m, beam_m,
         draught_m, draught_m, ts_naive, ts_naive],
    )


def mark_gap(
    con: duckdb.DuckDBPyConnection,
    gap_start: datetime,
    gap_end: datetime,
    detection_method: str,
) -> None:
    con.execute(
        """
        INSERT INTO collector_gaps (gap_start, gap_end, detection_method)
        VALUES (?, ?, ?)
        ON CONFLICT DO NOTHING
        """,
        [gap_start, gap_end, detection_method],
    )


def last_message_ts(con: duckdb.DuckDBPyConnection) -> datetime | None:
    row = con.execute("SELECT MAX(ts) FROM ais_messages").fetchone()
    return row[0] if row and row[0] else None
