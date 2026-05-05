"""Douglas-Peucker line simplification for vessel trails.

Operates in raw (lat, lon) degree space. Tolerance is interpreted as
perpendicular degree distance, which is good enough for thinning a
coastal trail to a few dozen visually-faithful points. Each input
point is a tuple of (lat, lon, anything-else); only lat/lon participate
in the geometry test.

Why hand-rolled instead of `rdp` from PyPI: that package depends on
numpy, and on Windows the AISStream collector has had numpy ABI
flake-out before. The trails are tiny — a from-scratch implementation
is ~30 lines and avoids the binary dep.
"""

from __future__ import annotations

from typing import Sequence


def _perp_distance(p, a, b) -> float:
    # Perpendicular distance from point p to segment a-b in lat/lon space.
    px, py = p[1], p[0]
    ax, ay = a[1], a[0]
    bx, by = b[1], b[0]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        # a and b coincide — distance reduces to point-to-point.
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    # Numerator is twice the signed area of the triangle a-b-p.
    num = abs(dy * px - dx * py + bx * ay - by * ax)
    return num / ((dx * dx + dy * dy) ** 0.5)


def _douglas_peucker(points: Sequence, tol: float) -> list:
    if len(points) < 3:
        return list(points)
    a, b = points[0], points[-1]
    max_d = -1.0
    max_i = -1
    for i in range(1, len(points) - 1):
        d = _perp_distance(points[i], a, b)
        if d > max_d:
            max_d = d
            max_i = i
    if max_d <= tol or max_i < 0:
        return [a, b]
    left = _douglas_peucker(points[: max_i + 1], tol)
    right = _douglas_peucker(points[max_i:], tol)
    return left[:-1] + right


def thin_trail(points: Sequence, *, tolerance_deg: float, max_points: int) -> list:
    """Return a thinned copy of `points`.

    `points` is an ordered sequence of (lat, lon, *rest) tuples. The
    thinned result preserves order and always keeps the first and last
    points. If RDP alone leaves more than `max_points`, the result is
    further down-sampled by uniform stride.
    """
    if not points:
        return []
    if len(points) <= 2:
        return list(points)
    out = _douglas_peucker(list(points), tolerance_deg)
    if len(out) <= max_points:
        return out
    # Pick max_points evenly-spaced indices over [0, len(out) - 1] so
    # the first and last points are always preserved. round() spreads
    # the residue when len(out) isn't a clean multiple.
    n = len(out)
    last = n - 1
    return [out[round(i * last / (max_points - 1))] for i in range(max_points)]
