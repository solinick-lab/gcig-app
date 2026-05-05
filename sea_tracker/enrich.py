from __future__ import annotations

import logging
from datetime import timedelta

import duckdb

from sea_tracker.classify import is_laden, size_class
from sea_tracker.geo import (
    HORMUZ_A,
    HORMUZ_B,
    TERMINALS,
    classify_hormuz_crossing,
    point_in_circle,
)

logger = logging.getLogger(__name__)


def update_vessel_size_class(con: duckdb.DuckDBPyConnection) -> None:
    rows = con.execute("SELECT mmsi, length_m FROM vessels").fetchall()
    for mmsi, length_m in rows:
        sc = size_class(length_m)
        con.execute("UPDATE vessels SET size_class = ? WHERE mmsi = ?", [sc, mmsi])


def detect_transits(con: duckdb.DuckDBPyConnection) -> int:
    """Walk position reports per MMSI; insert hormuz crossings into `transits`."""
    con.execute("DELETE FROM transits")
    # Tankers only at signal time, but transit detection runs for all and we
    # filter by ship_type at the signal level. Keep the table small by limiting
    # to vessels with ship_type 80-89.
    rows = con.execute(
        """
        SELECT m.mmsi, m.ts, m.lat, m.lon,
               v.size_class, v.ship_type, v.draught_m_max
        FROM ais_messages m
        JOIN vessels v ON v.mmsi = m.mmsi
        WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL
          AND v.ship_type BETWEEN 80 AND 89
        ORDER BY m.mmsi, m.ts
        """
    ).fetchall()

    inserts = []
    prev_by_mmsi: dict[int, tuple] = {}
    for mmsi, ts, lat, lon, sc, st, dmax in rows:
        prev = prev_by_mmsi.get(mmsi)
        prev_by_mmsi[mmsi] = (ts, lat, lon)
        if prev is None:
            continue
        direction = classify_hormuz_crossing((prev[1], prev[2]), (lat, lon))
        if direction is None:
            continue
        laden = is_laden(sc or "unknown", dmax)
        inserts.append((mmsi, ts, direction, laden, sc, st))

    if inserts:
        con.executemany(
            """
            INSERT INTO transits (vessel_mmsi, crossing_ts, direction, laden, size_class, ship_type)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (vessel_mmsi, crossing_ts) DO NOTHING
            """,
            inserts,
        )
    return len(inserts)


def detect_port_calls(con: duckdb.DuckDBPyConnection, *, min_dwell_hours: float = 6.0) -> int:
    """Detect vessel-in-terminal-polygon entry/exit; keep dwell >= min_dwell_hours."""
    con.execute("DELETE FROM port_calls")
    rows = con.execute(
        """
        SELECT m.mmsi, m.ts, m.lat, m.lon
        FROM ais_messages m
        JOIN vessels v ON v.mmsi = m.mmsi
        WHERE m.lat IS NOT NULL AND m.lon IS NOT NULL
          AND v.ship_type BETWEEN 80 AND 89
        ORDER BY m.mmsi, m.ts
        """
    ).fetchall()

    # Per (mmsi, terminal): track open intervals.
    open_calls: dict[tuple[int, str], list] = {}  # key -> [enter_ts, last_ts]
    completed = []

    def _terminal_at(lat: float, lon: float) -> str | None:
        for name, _country, clat, clon, r in TERMINALS:
            if point_in_circle((lat, lon), (clat, clon), r):
                return name
        return None

    last_term_by_mmsi: dict[int, str | None] = {}
    last_ts_by_mmsi: dict[int, object] = {}

    for mmsi, ts, lat, lon in rows:
        term = _terminal_at(lat, lon)
        prev_term = last_term_by_mmsi.get(mmsi)

        if term is not None and prev_term != term:
            # entered a new terminal (after being absent or in a different one)
            if prev_term is not None:
                key = (mmsi, prev_term)
                if key in open_calls:
                    enter_ts, last_ts = open_calls.pop(key)
                    completed.append((mmsi, prev_term, enter_ts, last_ts))
            open_calls[(mmsi, term)] = [ts, ts]
        elif term is not None and prev_term == term:
            open_calls[(mmsi, term)][1] = ts
        elif term is None and prev_term is not None:
            key = (mmsi, prev_term)
            if key in open_calls:
                enter_ts, last_ts = open_calls.pop(key)
                completed.append((mmsi, prev_term, enter_ts, last_ts))

        last_term_by_mmsi[mmsi] = term
        last_ts_by_mmsi[mmsi] = ts

    # close any still-open intervals at end of data
    for (mmsi, term), (enter_ts, last_ts) in open_calls.items():
        completed.append((mmsi, term, enter_ts, last_ts))

    inserts = []
    for mmsi, term, enter_ts, exit_ts in completed:
        dwell_h = (exit_ts - enter_ts).total_seconds() / 3600.0
        if dwell_h >= min_dwell_hours:
            inserts.append((mmsi, term, enter_ts, exit_ts, dwell_h))

    if inserts:
        con.executemany(
            """
            INSERT INTO port_calls (vessel_mmsi, terminal, enter_ts, exit_ts, dwell_hours)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (vessel_mmsi, terminal, enter_ts) DO NOTHING
            """,
            inserts,
        )
    return len(inserts)


def run_enrich(con: duckdb.DuckDBPyConnection) -> dict[str, int]:
    update_vessel_size_class(con)
    n_t = detect_transits(con)
    n_p = detect_port_calls(con)
    logger.info("enrich: transits=%d port_calls=%d", n_t, n_p)
    return {"transits": n_t, "port_calls": n_p}
