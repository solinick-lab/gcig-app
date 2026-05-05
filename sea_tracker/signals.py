from __future__ import annotations

import logging
from datetime import date, datetime, time, timedelta

import duckdb

from sea_tracker.geo import TERMINALS

logger = logging.getLogger(__name__)


_COUNTRIES = ["saudi", "iran", "kuwait", "iraq", "uae", "qatar"]


def _persist(con: duckdb.DuckDBPyConnection, d: date, name: str, value: float | None) -> None:
    con.execute(
        "INSERT INTO signals_daily (date, signal_name, value) VALUES (?, ?, ?) "
        "ON CONFLICT (date, signal_name) DO UPDATE SET value = excluded.value",
        [d, name, value],
    )


def compute_daily_signals(con: duckdb.DuckDBPyConnection, *, day: date) -> None:
    start = datetime.combine(day, time.min)
    end = start + timedelta(days=1)

    # 1. hormuz_outbound_laden_count
    n_out_laden = con.execute(
        "SELECT COUNT(*) FROM transits "
        "WHERE direction = 'outbound' AND laden = TRUE "
        "  AND crossing_ts >= ? AND crossing_ts < ?",
        [start, end],
    ).fetchone()[0]
    _persist(con, day, "hormuz_outbound_laden_count", float(n_out_laden))

    # 2. hormuz_outbound_dwt_proxy = sum(length * beam) for those transits
    dwt_out = con.execute(
        """
        SELECT COALESCE(SUM(v.length_m * v.beam_m), 0)
        FROM transits t JOIN vessels v ON v.mmsi = t.vessel_mmsi
        WHERE t.direction = 'outbound' AND t.laden = TRUE
          AND t.crossing_ts >= ? AND t.crossing_ts < ?
        """,
        [start, end],
    ).fetchone()[0]
    _persist(con, day, "hormuz_outbound_dwt_proxy", float(dwt_out))

    # 3. hormuz_inbound_ballast_count
    n_in_ballast = con.execute(
        "SELECT COUNT(*) FROM transits "
        "WHERE direction = 'inbound' AND laden = FALSE "
        "  AND crossing_ts >= ? AND crossing_ts < ?",
        [start, end],
    ).fetchone()[0]
    _persist(con, day, "hormuz_inbound_ballast_count", float(n_in_ballast))

    # 4. terminal_departures_<country>
    term_country = {name: country for name, country, _, _, _ in TERMINALS}
    for country in _COUNTRIES:
        terms = [n for n, c in term_country.items() if c == country]
        if not terms:
            _persist(con, day, f"terminal_departures_{country}", 0.0)
            continue
        placeholders = ",".join("?" * len(terms))
        n = con.execute(
            f"SELECT COUNT(*) FROM port_calls WHERE terminal IN ({placeholders}) "
            "AND exit_ts >= ? AND exit_ts < ?",
            [*terms, start, end],
        ).fetchone()[0]
        _persist(con, day, f"terminal_departures_{country}", float(n))

    # 5. gulf_laden_ballast_ratio (snapshot at start)
    # heuristic: most recent draught observed for each tanker active on this day
    ratio = con.execute(
        """
        WITH active AS (
            SELECT DISTINCT m.mmsi
            FROM ais_messages m JOIN vessels v ON v.mmsi = m.mmsi
            WHERE v.ship_type BETWEEN 80 AND 89
              AND m.ts >= ? AND m.ts < ?
        )
        SELECT
            CASE WHEN COUNT(*) = 0 THEN NULL
                 ELSE SUM(CASE WHEN
                    (v.size_class = 'vlcc' AND v.draught_m_max >= 17.0) OR
                    (v.size_class = 'suezmax' AND v.draught_m_max >= 13.5) OR
                    (v.size_class = 'aframax' AND v.draught_m_max >= 11.0) OR
                    (v.size_class = 'small' AND v.draught_m_max >= 8.0)
                 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) END
        FROM active a JOIN vessels v ON v.mmsi = a.mmsi
        """,
        [start, end],
    ).fetchone()[0]
    _persist(con, day, "gulf_laden_ballast_ratio", float(ratio) if ratio is not None else None)

    # 6. anchored_tanker_count: sog<1 within 15km of any terminal centroid
    # cumulative dwell >= 4h within day d
    anchored_n = 0
    rows = con.execute(
        """
        SELECT m.mmsi, m.ts, m.lat, m.lon, m.sog
        FROM ais_messages m JOIN vessels v ON v.mmsi = m.mmsi
        WHERE v.ship_type BETWEEN 80 AND 89 AND m.sog < 1.0
          AND m.ts >= ? AND m.ts < ?
          AND m.lat IS NOT NULL AND m.lon IS NOT NULL
        ORDER BY m.mmsi, m.ts
        """,
        [start, end],
    ).fetchall()

    from sea_tracker.geo import haversine_km
    counts: dict[int, float] = {}
    last: dict[int, datetime] = {}
    for mmsi, ts, lat, lon, _sog in rows:
        near = any(haversine_km(lat, lon, clat, clon) <= 15.0
                   for _, _c, clat, clon, _ in TERMINALS)
        if not near:
            last.pop(mmsi, None)
            continue
        if mmsi in last:
            counts[mmsi] = counts.get(mmsi, 0.0) + (ts - last[mmsi]).total_seconds() / 3600.0
        last[mmsi] = ts
    anchored_n = sum(1 for _, h in counts.items() if h >= 4.0)
    _persist(con, day, "anchored_tanker_count", float(anchored_n))

    # 7. gulf_total_dwt_proxy: sum(length*beam) over distinct active tankers in bbox today
    total_dwt = con.execute(
        """
        WITH active AS (
            SELECT DISTINCT m.mmsi
            FROM ais_messages m JOIN vessels v ON v.mmsi = m.mmsi
            WHERE v.ship_type BETWEEN 80 AND 89
              AND m.ts >= ? AND m.ts < ?
        )
        SELECT COALESCE(SUM(v.length_m * v.beam_m), 0)
        FROM active a JOIN vessels v ON v.mmsi = a.mmsi
        """,
        [start, end],
    ).fetchone()[0]
    _persist(con, day, "gulf_total_dwt_proxy", float(total_dwt))


def compute_signals_range(
    con: duckdb.DuckDBPyConnection, *, start_day: date, end_day: date
) -> None:
    d = start_day
    while d <= end_day:
        compute_daily_signals(con, day=d)
        d += timedelta(days=1)
