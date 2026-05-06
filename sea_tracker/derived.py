"""Derived signals — interpretation layer on top of the raw counts.

These are the headline cards a member or PM actually wants to read at
a glance:

  - hormuz_throughput_mbbl   : real-time estimate of barrels/day
                               flowing out of the Gulf, in industry units
                               (~20 Mbbl/d is the EIA baseline)
  - flow_health              : 0-100. 100 = ships flowing at or above
                               30-day median through the strait. 0 = no
                               outbound traffic registered today.
  - iran_export_share        : % of today's terminal departures that
                               left an Iranian terminal. Sustained drops
                               correlate with sanctions impact.
  - opec_coordination_z      : z-score of today's combined OPEC-Gulf
                               terminal departures vs trailing 30 days.
                               |z| > 2 ≈ coordinated production move.
  - chokepoint_pressure      : anchored tankers near Hormuz / outbound
                               crossings. Spikes mean traffic is backing
                               up at the strait.

All five are derivable from the data already in DuckDB — no schema
change. Any value that can't be computed yet (insufficient history,
zero denominator) returns None and the React panel renders an em-dash.
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, time, timedelta
from typing import Any

import duckdb

# Tanker barrels-of-cargo per (length × beam) m². Derived from the
# canonical formula: barrels ≈ block_coeff (0.85) × cargo_fraction
# (0.95) × barrels-per-m³ (6.29) × L × B × draft. Draft is taken as
# the laden threshold for each size class — this is the conservative
# "barely-laden" assumption, which matches what we tag as `laden=TRUE`
# in detect_transits. Calibration check: a VLCC (333×60×17) yields
# ~1.7M barrels — slightly under the typical 2M for a fully-loaded
# VLCC, which is right since "laden" only requires the laden draft
# threshold (not max draft).
_LADEN_DRAFT_M = {
    "vlcc":    17.0,
    "suezmax": 13.5,
    "aframax": 11.0,
    "small":    8.0,
}
_BARRELS_FORMULA_K = 0.85 * 0.95 * 6.29  # ≈ 5.08


_OPEC_COUNTRIES = ["saudi", "iran", "kuwait", "iraq", "uae", "qatar"]


# Persian Gulf approach + Strait of Hormuz zone. Used for chokepoint
# pressure: vessels at sog<1 inside this box are "waiting at the strait".
_HORMUZ_ZONE_LAT = (25.50, 27.00)
_HORMUZ_ZONE_LON = (55.50, 57.00)

# Tighter boxes for the SAR-derived counts. The strait box is the
# actual chokepoint (the line of geopolitical interest); the Iran-
# side box covers Bandar Abbas, Lavan, Sirri — the AIS-blind zone.
_SAR_STRAIT_BBOX = (26.00, 26.80, 56.00, 56.80)
_SAR_IRAN_BBOX   = (26.50, 27.30, 54.00, 57.20)


def _signal_value(con: duckdb.DuckDBPyConnection, *, day: date, name: str) -> float | None:
    row = con.execute(
        "SELECT value FROM signals_daily WHERE date = ? AND signal_name = ?",
        [day, name],
    ).fetchone()
    if not row:
        return None
    return row[0]


def _opec_total_for_day(con: duckdb.DuckDBPyConnection, day: date) -> float:
    total = 0.0
    for c in _OPEC_COUNTRIES:
        v = _signal_value(con, day=day, name=f"terminal_departures_{c}")
        total += v or 0.0
    return total


def hormuz_throughput_mbbl(
    con: duckdb.DuckDBPyConnection, *, day: date
) -> dict[str, Any]:
    """Estimated Mbbl/d outbound through Hormuz today."""
    start = datetime.combine(day, time.min)
    end = start + timedelta(days=1)
    rows = con.execute(
        """
        SELECT v.length_m, v.beam_m, v.size_class
        FROM transits t JOIN vessels v ON v.mmsi = t.vessel_mmsi
        WHERE t.direction = 'outbound' AND t.laden = TRUE
          AND t.crossing_ts >= ? AND t.crossing_ts < ?
          AND v.length_m IS NOT NULL AND v.beam_m IS NOT NULL
        """,
        [start, end],
    ).fetchall()
    if not rows:
        return {"value": 0.0, "tanker_count": 0, "baseline_mbbl": 20.0}
    total_barrels = 0.0
    for length, beam, size_class in rows:
        draft = _LADEN_DRAFT_M.get(size_class, 8.0)
        total_barrels += _BARRELS_FORMULA_K * float(length) * float(beam) * draft
    mbbl = total_barrels / 1_000_000.0
    return {
        "value": round(mbbl, 2),
        "tanker_count": len(rows),
        "baseline_mbbl": 20.0,
    }


def flow_health(
    con: duckdb.DuckDBPyConnection, *, day: date
) -> dict[str, Any]:
    """0-100. Today's outbound laden count vs 30-day median.

    Insufficient history (<7 prior days with any value) returns
    `value: None` so the UI shows "warming up".
    """
    today_v = _signal_value(con, day=day, name="hormuz_outbound_laden_count") or 0.0
    rows = con.execute(
        """
        SELECT value FROM signals_daily
        WHERE signal_name = ? AND date < ? AND value IS NOT NULL
        ORDER BY date DESC LIMIT 30
        """,
        ["hormuz_outbound_laden_count", day],
    ).fetchall()
    history = [r[0] for r in rows if r[0] is not None]
    if len(history) < 7:
        return {"value": None, "today": today_v, "median_30d": None, "status": "warming_up"}
    median = statistics.median(history)
    if median <= 0:
        return {"value": None, "today": today_v, "median_30d": median, "status": "warming_up"}
    raw = (today_v / median) * 100.0
    score = max(0, min(100, int(round(raw))))
    if score >= 80:
        status = "healthy"
    elif score >= 40:
        status = "below_normal"
    else:
        status = "stalled"
    return {
        "value": score,
        "today": today_v,
        "median_30d": median,
        "status": status,
    }


def iran_export_share(
    con: duckdb.DuckDBPyConnection, *, day: date
) -> dict[str, Any]:
    iran = _signal_value(con, day=day, name="terminal_departures_iran") or 0.0
    total = _opec_total_for_day(con, day)
    if total == 0:
        return {"value": None, "iran": iran, "opec_total": 0.0, "status": "warming_up"}
    pct = iran / total * 100.0
    # Iran historically ~5-15% of OPEC-Gulf exports under sanctions,
    # 15-25% pre-sanctions. Below 5% sustained = stress signal.
    if pct < 3.0:
        status = "stress"
    elif pct < 8.0:
        status = "low"
    else:
        status = "ok"
    return {
        "value": round(pct, 1),
        "iran": iran,
        "opec_total": total,
        "status": status,
    }


def opec_coordination_z(
    con: duckdb.DuckDBPyConnection, *, day: date
) -> dict[str, Any]:
    today_total = _opec_total_for_day(con, day)
    history: list[float] = []
    for i in range(1, 31):
        d = day - timedelta(days=i)
        history.append(_opec_total_for_day(con, d))
    nonzero = [h for h in history if h > 0]
    if len(nonzero) < 7:
        return {"value": None, "today": today_total, "mean_30d": None, "status": "warming_up"}
    mean = statistics.fmean(history)
    sd = statistics.pstdev(history) if len(history) > 1 else 0.0
    if sd == 0:
        # Perfectly-flat history. If today equals the constant, no
        # signal. Otherwise it's a categorical break — pick a finite
        # but large z so the UI flags it as anomaly without us having
        # to ship Infinity through JSON.
        if today_total == mean:
            return {"value": 0.0, "today": today_total, "mean_30d": mean, "status": "ok"}
        z = 99.0 if today_total > mean else -99.0
        return {"value": z, "today": today_total, "mean_30d": mean, "status": "anomaly"}
    z = (today_total - mean) / sd
    abs_z = abs(z)
    if abs_z > 2:
        status = "anomaly"
    elif abs_z > 1:
        status = "watch"
    else:
        status = "ok"
    return {
        "value": round(z, 2),
        "today": today_total,
        "mean_30d": round(mean, 1),
        "status": status,
    }


def chokepoint_pressure(
    con: duckdb.DuckDBPyConnection, *, day: date
) -> dict[str, Any]:
    start = datetime.combine(day, time.min)
    end = start + timedelta(days=1)
    anchored = con.execute(
        """
        SELECT COUNT(DISTINCT mmsi) FROM ais_messages
        WHERE sog < 1.0
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
          AND ts >= ? AND ts < ?
        """,
        [_HORMUZ_ZONE_LAT[0], _HORMUZ_ZONE_LAT[1],
         _HORMUZ_ZONE_LON[0], _HORMUZ_ZONE_LON[1], start, end],
    ).fetchone()[0]
    outbound = con.execute(
        """
        SELECT COUNT(*) FROM transits
        WHERE direction = 'outbound'
          AND crossing_ts >= ? AND crossing_ts < ?
        """,
        [start, end],
    ).fetchone()[0]
    if outbound == 0:
        # No transits today → can't form a ratio. Report the raw
        # anchored count and let the UI describe it.
        return {
            "value": None,
            "anchored_at_strait": anchored,
            "outbound_today": 0,
            "status": "no_outbound",
        }
    ratio = anchored / outbound
    if ratio >= 5:
        status = "alarm"
    elif ratio >= 2:
        status = "elevated"
    else:
        status = "ok"
    return {
        "value": round(ratio, 2),
        "anchored_at_strait": anchored,
        "outbound_today": outbound,
        "status": status,
    }


def _sar_zone_count(
    con: duckdb.DuckDBPyConnection,
    *,
    bbox: tuple[float, float, float, float],
) -> dict[str, Any]:
    """Count SAR detections (and tanker-class subset) in the bbox,
    from the most recent scene that intersected it. Returns the
    scene's acquisition timestamp so the UI can show "X hours ago"
    freshness.

    Different from the live-AIS chokepoint count because SAR is a
    snapshot per pass, not continuous tracking — we report what
    showed up in the imagery, not a 24 h transit total.
    """
    lat_min, lat_max, lon_min, lon_max = bbox
    latest = con.execute(
        """
        SELECT scene_id, MAX(detected_at) AS latest
        FROM sar_detections
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
        GROUP BY scene_id
        ORDER BY latest DESC
        LIMIT 1
        """,
        [lat_min, lat_max, lon_min, lon_max],
    ).fetchone()
    if not latest:
        return {
            "value": None,
            "tanker_count": 0,
            "all_count": 0,
            "scene_id": None,
            "asOf": None,
            "status": "warming_up",
        }
    scene_id, acquired_at = latest
    counts = con.execute(
        """
        SELECT
            SUM(CASE WHEN likely_tanker THEN 1 ELSE 0 END) AS tankers,
            COUNT(*) AS total
        FROM sar_detections
        WHERE scene_id = ?
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
        """,
        [scene_id, lat_min, lat_max, lon_min, lon_max],
    ).fetchone()
    tankers = int(counts[0] or 0)
    total = int(counts[1] or 0)
    return {
        "value": tankers,
        "tanker_count": tankers,
        "all_count": total,
        "scene_id": scene_id,
        "asOf": acquired_at.isoformat() + "Z" if acquired_at else None,
        "status": "ok" if tankers > 0 else "no_detections",
    }


def sar_strait_vessels(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Tanker-class SAR detections in the Hormuz strait box at the
    most recent pass over the strait."""
    return _sar_zone_count(con, bbox=_SAR_STRAIT_BBOX)


def sar_iran_activity(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Tanker-class SAR detections along the Iranian south coast
    (Bandar Abbas + Lavan + Sirri) at the most recent pass."""
    return _sar_zone_count(con, bbox=_SAR_IRAN_BBOX)


def compute_all(con: duckdb.DuckDBPyConnection, *, day: date) -> dict[str, Any]:
    """Build the full derived-signals block for the snapshot payload.

    Each metric is its own dict carrying value + supporting numbers +
    status string ("ok" / "warming_up" / "anomaly" / etc.) the React
    cards key off for color and copy.
    """
    return {
        "asOf": day.isoformat(),
        "hormuzThroughputMbbl": hormuz_throughput_mbbl(con, day=day),
        "flowHealth":            flow_health(con, day=day),
        "iranExportShare":       iran_export_share(con, day=day),
        "opecCoordinationZ":     opec_coordination_z(con, day=day),
        "chokepointPressure":    chokepoint_pressure(con, day=day),
        "sarStraitVessels":      sar_strait_vessels(con),
        "sarIranActivity":       sar_iran_activity(con),
    }
