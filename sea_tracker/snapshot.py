"""Build the rolling snapshot payload published to gcig-api.

Reads from DuckDB (in another process the collector is writing to it
concurrently — DuckDB allows many readers + one writer). Produces the
shape the React /tankers page consumes verbatim, plus enough metadata
that the server side can stamp it and persist as JSONB.

Pricey or stateful work: don't do any here. This must run in a few
seconds even when the bbox holds a thousand vessels.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import duckdb

from sea_tracker.derived import compute_all as _compute_derived
from sea_tracker.geo import TERMINALS
from sea_tracker.rdp import thin_trail

# The seven daily signals defined in signals.py — kept in sync with
# what `compute_daily_signals` writes to signals_daily. The map page
# expects every key to be present (panel cards key off this list).
_SIGNAL_NAMES = [
    "hormuz_outbound_laden_count",
    "hormuz_outbound_dwt_proxy",
    "hormuz_inbound_ballast_count",
    "gulf_laden_ballast_ratio",
    "anchored_tanker_count",
    "gulf_total_dwt_proxy",
    "terminal_departures_saudi",
    "terminal_departures_iran",
    "terminal_departures_kuwait",
    "terminal_departures_iraq",
    "terminal_departures_uae",
    "terminal_departures_qatar",
]


def _latest_position_per_vessel(
    con: duckdb.DuckDBPyConnection, *, bbox, now: datetime, freshness_minutes: int
):
    lat_min, lat_max, lon_min, lon_max = bbox
    cutoff = now - timedelta(minutes=freshness_minutes)
    return con.execute(
        """
        WITH latest AS (
            SELECT mmsi, MAX(ts) AS ts FROM ais_messages
            WHERE lat IS NOT NULL AND lon IS NOT NULL
              AND ts >= ?
              AND lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
            GROUP BY mmsi
        )
        SELECT m.mmsi, m.ts, m.lat, m.lon, m.sog, m.cog, m.heading,
               v.name, v.ship_type, v.size_class, v.draught_m_max
        FROM latest l
        JOIN ais_messages m ON m.mmsi = l.mmsi AND m.ts = l.ts
        LEFT JOIN vessels v ON v.mmsi = m.mmsi
        """,
        [cutoff, lat_min, lat_max, lon_min, lon_max],
    ).fetchall()


def _trail_for_mmsi(
    con: duckdb.DuckDBPyConnection, mmsi: int, *, now: datetime, hours: int
):
    cutoff = now - timedelta(hours=hours)
    return con.execute(
        """
        SELECT lat, lon, ts
        FROM ais_messages
        WHERE mmsi = ?
          AND ts >= ?
          AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY ts ASC
        """,
        [mmsi, cutoff],
    ).fetchall()


def _laden_for(size_class: str | None, draught: float | None) -> bool | None:
    if size_class is None or draught is None:
        return None
    thresholds = {"vlcc": 17.0, "suezmax": 13.5, "aframax": 11.0, "small": 8.0}
    t = thresholds.get(size_class)
    if t is None:
        return None
    return draught >= t


def _latest_signal_values(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, Any]]:
    rows = con.execute(
        """
        SELECT signal_name, date, value
        FROM signals_daily
        WHERE (signal_name, date) IN (
            SELECT signal_name, MAX(date)
            FROM signals_daily
            GROUP BY signal_name
        )
        """,
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for name, day, value in rows:
        if name not in _SIGNAL_NAMES:
            continue
        out[name] = {"value": value, "asOf": day.isoformat() if day else None}
    return out


def build_snapshot(
    con: duckdb.DuckDBPyConnection,
    *,
    bbox: tuple[float, float, float, float],
    now: datetime,
    # Default 6 h instead of 30 min: AISStream's free tier delivers
    # the Persian Gulf at roughly 0.1 msg/sec, so a 30-min window
    # only catches the dozen-or-so MMSIs that happen to transmit
    # inside it and the map looks empty. Widening to 6 h surfaces
    # most vessels we've recorded over the past quarter-day, which
    # matches what members actually want to see (recent activity in
    # the Gulf). Stale positions are mitigated by the per-vessel
    # `lastSeen` timestamp the drawer already shows.
    freshness_minutes: int = 360,
    trail_hours: int = 24,
    trail_tolerance_deg: float = 0.0005,  # ~50 m at this latitude
    trail_max_points: int = 200,
) -> dict[str, Any]:
    """Return the JSON-serializable payload posted to /api/sea/snapshot."""
    rows = _latest_position_per_vessel(
        con, bbox=bbox, now=now, freshness_minutes=freshness_minutes
    )
    vessels: list[dict[str, Any]] = []
    for (
        mmsi, ts, lat, lon, sog, cog, heading,
        name, ship_type, size_class, draught,
    ) in rows:
        trail_raw = _trail_for_mmsi(con, mmsi, now=now, hours=trail_hours)
        trail_thinned = thin_trail(
            trail_raw,
            tolerance_deg=trail_tolerance_deg,
            max_points=trail_max_points,
        )
        trail_serial = [
            [float(t[0]), float(t[1]), t[2].isoformat() + "Z"]
            for t in trail_thinned
        ]
        vessels.append({
            "mmsi": int(mmsi),
            "name": name,
            "shipType": ship_type,
            "sizeClass": size_class,
            "laden": _laden_for(size_class, draught),
            "lat": float(lat),
            "lon": float(lon),
            "sog": float(sog) if sog is not None else None,
            "cog": float(cog) if cog is not None else None,
            "heading": int(heading) if heading is not None else None,
            "lastSeen": ts.isoformat() + "Z",
            "trail": trail_serial,
        })

    terminals = [
        {"name": n, "country": c, "lat": clat, "lon": clon, "radiusKm": r}
        for n, c, clat, clon, r in TERMINALS
    ]

    derived = _compute_derived(con, day=datetime.now(timezone.utc).date())

    # Coverage tallies — give the page something to surface beyond the
    # "live in the last 6 h" count. We're working with thin terrestrial
    # AIS, so a snapshot of "76 visible right now" can read as broken
    # when really we've cumulatively recorded hundreds of vessels.
    coverage = _coverage_stats(con, now=now)

    return {
        "bbox": [bbox[0], bbox[1], bbox[2], bbox[3]],
        "vessels": vessels,
        "terminals": terminals,
        "signals": _latest_signal_values(con),
        "derived": derived,
        "coverage": coverage,
    }


def _coverage_stats(con: duckdb.DuckDBPyConnection, *, now: datetime) -> dict[str, Any]:
    """Cumulative vessel counts so the UI can show "X visible / Y this
    week / Z all-time" rather than only the live snapshot count."""
    one_hour = now - timedelta(hours=1)
    six_hours = now - timedelta(hours=6)
    twenty_four = now - timedelta(hours=24)
    seven_days = now - timedelta(days=7)

    def distinct_since(ts) -> int:
        row = con.execute(
            "SELECT COUNT(DISTINCT mmsi) FROM ais_messages WHERE ts >= ?",
            [ts],
        ).fetchone()
        return int(row[0] if row else 0)

    total_row = con.execute(
        "SELECT COUNT(DISTINCT mmsi) FROM ais_messages"
    ).fetchone()
    return {
        "vessels_last_hour":  distinct_since(one_hour),
        "vessels_last_6h":    distinct_since(six_hours),
        "vessels_last_24h":   distinct_since(twenty_four),
        "vessels_last_7d":    distinct_since(seven_days),
        "vessels_all_time":   int(total_row[0] if total_row else 0),
    }
