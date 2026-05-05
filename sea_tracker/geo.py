from __future__ import annotations

import math

# (lat_min, lat_max, lon_min, lon_max)
PERSIAN_GULF_BBOX = (23.5, 30.5, 47.5, 57.5)

# Hormuz crossing line endpoints (lat, lon). Oriented A → B: outbound vessel
# crosses from the Gulf side (positive `side_of_segment`) to the Oman side.
HORMUZ_A: tuple[float, float] = (26.65, 56.10)
HORMUZ_B: tuple[float, float] = (26.10, 56.55)


def in_bbox(lat: float, lon: float, bbox: tuple[float, float, float, float]) -> bool:
    lat_min, lat_max, lon_min, lon_max = bbox
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def side_of_segment(
    a: tuple[float, float], b: tuple[float, float], p: tuple[float, float]
) -> float:
    """2D cross product of (b - a) and (p - a) using (lon, lat). Positive = left side."""
    ax, ay = a[1], a[0]
    bx, by = b[1], b[0]
    px, py = p[1], p[0]
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)


def _segments_cross(
    a: tuple[float, float],
    b: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
) -> bool:
    s1 = side_of_segment(a, b, p1)
    s2 = side_of_segment(a, b, p2)
    if s1 * s2 >= 0:
        return False
    s3 = side_of_segment(p1, p2, a)
    s4 = side_of_segment(p1, p2, b)
    return s3 * s4 < 0


def classify_hormuz_crossing(
    prev: tuple[float, float], curr: tuple[float, float]
) -> str | None:
    """Return 'outbound', 'inbound', or None for two consecutive vessel positions."""
    if not _segments_cross(HORMUZ_A, HORMUZ_B, prev, curr):
        return None
    s_prev = side_of_segment(HORMUZ_A, HORMUZ_B, prev)
    return "outbound" if s_prev > 0 else "inbound"


def point_in_circle(
    p: tuple[float, float], center: tuple[float, float], radius_km: float
) -> bool:
    return haversine_km(p[0], p[1], center[0], center[1]) <= radius_km


# Loading terminal centroids: (name, country, lat, lon, radius_km)
TERMINALS: list[tuple[str, str, float, float, float]] = [
    ("ras_tanura", "saudi", 26.65, 50.17, 8.0),
    ("juaymah", "saudi", 26.92, 50.05, 8.0),
    ("kharg", "iran", 29.25, 50.32, 8.0),
    ("mina_al_ahmadi", "kuwait", 29.07, 48.20, 8.0),
    ("basra_oil", "iraq", 29.69, 48.81, 8.0),
    ("jebel_dhanna", "uae", 24.18, 52.61, 8.0),
    ("das", "uae", 25.15, 52.87, 8.0),
    ("halul", "qatar", 25.66, 52.41, 8.0),
    ("fujairah", "uae", 25.10, 56.40, 8.0),
]


def terminal_for_point(lat: float, lon: float) -> tuple[str, str] | None:
    """Return (terminal_name, country) for first matching terminal, or None."""
    for name, country, clat, clon, r in TERMINALS:
        if point_in_circle((lat, lon), (clat, clon), r):
            return name, country
    return None
