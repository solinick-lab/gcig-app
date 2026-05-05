from __future__ import annotations

_LADEN_THRESHOLD_M = {
    "vlcc": 17.0,
    "suezmax": 13.5,
    "aframax": 11.0,
    "small": 8.0,
}


def size_class(length_m: int | None) -> str:
    if length_m is None:
        return "unknown"
    if length_m >= 300:
        return "vlcc"
    if length_m >= 250:
        return "suezmax"
    if length_m >= 220:
        return "aframax"
    return "small"


def is_laden(size_class_name: str, draught_m: float | None) -> bool | None:
    if draught_m is None or size_class_name == "unknown":
        return None
    threshold = _LADEN_THRESHOLD_M.get(size_class_name)
    if threshold is None:
        return None
    return draught_m >= threshold
