from datetime import datetime, timedelta

import duckdb
import pytest

from sea_tracker.db import init_schema
from sea_tracker.snapshot import build_snapshot

BBOX = (23.5, 30.5, 47.5, 57.5)
NOW = datetime(2026, 5, 4, 20, 0, 0)


@pytest.fixture
def con():
    c = duckdb.connect(":memory:")
    init_schema(c)
    yield c
    c.close()


def _seed_vessel(con, mmsi, name, ship_type=80, length_m=320, beam_m=58, draught=18.0, size_class="vlcc"):
    con.execute(
        "INSERT INTO vessels (mmsi, name, ship_type, length_m, beam_m, draught_m_max, size_class, last_seen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [mmsi, name, ship_type, length_m, beam_m, draught, size_class, NOW],
    )


def _seed_position(con, mmsi, lat, lon, ts, sog=10.0, cog=90.0, heading=90):
    con.execute(
        "INSERT INTO ais_messages (ts, mmsi, msg_type, lat, lon, sog, cog, heading) "
        "VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
        [ts, mmsi, lat, lon, sog, cog, heading],
    )


def _seed_signal(con, day, name, value):
    con.execute(
        "INSERT INTO signals_daily (date, signal_name, value) VALUES (?, ?, ?)",
        [day, name, value],
    )


def test_empty_db_returns_minimal_payload(con):
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["bbox"] == list(BBOX)
    assert out["vessels"] == []
    assert out["signals"] == {}
    assert isinstance(out["terminals"], list) and len(out["terminals"]) > 0


def test_vessel_inside_bbox_and_recent_appears(con):
    _seed_vessel(con, 1, "TANKER ONE")
    _seed_position(con, 1, lat=26.0, lon=52.0, ts=NOW - timedelta(minutes=5))
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert len(out["vessels"]) == 1
    v = out["vessels"][0]
    assert v["mmsi"] == 1
    assert v["name"] == "TANKER ONE"
    assert v["sizeClass"] == "vlcc"
    assert v["lat"] == 26.0 and v["lon"] == 52.0


def test_vessel_outside_bbox_is_dropped(con):
    _seed_vessel(con, 2, "OUT OF BOX")
    _seed_position(con, 2, lat=10.0, lon=10.0, ts=NOW - timedelta(minutes=5))
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["vessels"] == []


def test_stale_vessel_is_dropped(con):
    _seed_vessel(con, 3, "STALE")
    _seed_position(con, 3, lat=26.0, lon=52.0, ts=NOW - timedelta(hours=2))
    out = build_snapshot(con, bbox=BBOX, now=NOW, freshness_minutes=30)
    assert out["vessels"] == []


def test_trail_built_and_thinned(con):
    _seed_vessel(con, 4, "TRAIL")
    # Last position fresh
    _seed_position(con, 4, lat=26.5, lon=52.5, ts=NOW - timedelta(minutes=2))
    # 50 historical points across 24h
    for i in range(50):
        t = NOW - timedelta(hours=24) + timedelta(minutes=i * 28)
        lat = 26.0 + 0.01 * i
        lon = 52.0 + 0.01 * i
        _seed_position(con, 4, lat=lat, lon=lon, ts=t)
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    v = out["vessels"][0]
    assert "trail" in v
    assert len(v["trail"]) <= 200
    assert len(v["trail"]) >= 1
    first = v["trail"][0]
    assert isinstance(first, list) and len(first) == 3


def test_latest_signal_per_name_is_picked(con):
    _seed_signal(con, "2026-05-02", "anchored_tanker_count", 7.0)
    _seed_signal(con, "2026-05-03", "anchored_tanker_count", 9.0)
    _seed_signal(con, "2026-05-03", "hormuz_outbound_laden_count", 14.0)
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["signals"]["anchored_tanker_count"]["value"] == 9.0
    assert out["signals"]["anchored_tanker_count"]["asOf"] == "2026-05-03"
    assert out["signals"]["hormuz_outbound_laden_count"]["value"] == 14.0
