from datetime import datetime, timedelta

from sea_tracker.rdp import thin_trail


def _pt(lat, lon, t):
    return (lat, lon, t)


def test_empty_input_returns_empty():
    assert thin_trail([], tolerance_deg=0.001, max_points=200) == []


def test_two_points_unchanged():
    a = _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0))
    b = _pt(26.1, 52.1, datetime(2026, 5, 4, 10, 30))
    out = thin_trail([a, b], tolerance_deg=0.001, max_points=200)
    assert out == [a, b]


def test_collinear_points_collapse_to_endpoints():
    # Three collinear points in lat-lon space; the middle one should drop.
    pts = [
        _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0)),
        _pt(26.5, 52.5, datetime(2026, 5, 4, 10, 30)),
        _pt(27.0, 53.0, datetime(2026, 5, 4, 11, 0)),
    ]
    out = thin_trail(pts, tolerance_deg=0.01, max_points=200)
    assert out == [pts[0], pts[2]]


def test_zigzag_keeps_inflection_points():
    # A clear zigzag: any reasonable RDP must keep at least 3 points.
    pts = [
        _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0)),
        _pt(26.5, 52.5, datetime(2026, 5, 4, 10, 10)),
        _pt(26.0, 53.0, datetime(2026, 5, 4, 10, 20)),
        _pt(26.5, 53.5, datetime(2026, 5, 4, 10, 30)),
    ]
    out = thin_trail(pts, tolerance_deg=0.001, max_points=200)
    assert len(out) >= 3
    assert out[0] == pts[0]
    assert out[-1] == pts[-1]


def test_max_points_cap_is_enforced():
    # 500 noisy points; cap should clamp output length.
    base = datetime(2026, 5, 4, 10, 0)
    pts = []
    for i in range(500):
        lat = 26.0 + 0.001 * (i % 7)
        lon = 52.0 + 0.001 * i
        pts.append(_pt(lat, lon, base + timedelta(seconds=i)))
    out = thin_trail(pts, tolerance_deg=1e-9, max_points=50)
    assert len(out) <= 50
    assert out[0] == pts[0]
    assert out[-1] == pts[-1]
