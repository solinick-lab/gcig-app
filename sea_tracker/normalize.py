from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

# AIS msg_type for normalized rows (we collapse class A 1/2/3 → 1, B 18/19 → 18, static 5/24 → 5/24)
_POSITION_TYPE = 1
_STATIC_TYPE = 5


@dataclass
class NormalizedMessage:
    message_row: dict[str, Any]
    vessel_update: dict[str, Any] | None


def _parse_ts(s: str | None) -> datetime:
    if not s:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    # AISStream format: "2026-05-04 12:34:56.789 +0000 UTC"
    s = s.replace(" UTC", "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z"):
        try:
            return datetime.strptime(s, fmt).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            continue
    raise ValueError(f"unparseable ts: {s!r}")


def normalize_message(payload: dict[str, Any]) -> NormalizedMessage | None:
    mtype = payload.get("MessageType")
    meta = payload.get("MetaData") or {}
    inner = (payload.get("Message") or {})
    raw = json.dumps(payload, separators=(",", ":"))
    ts = _parse_ts(meta.get("time_utc"))

    if mtype == "PositionReport":
        body = inner.get("PositionReport") or {}
        mmsi = int(body.get("UserID") or meta.get("MMSI") or 0)
        if mmsi == 0:
            return None
        row = {
            "ts": ts,
            "mmsi": mmsi,
            "msg_type": _POSITION_TYPE,
            "lat": body.get("Latitude") if body.get("Latitude") is not None else meta.get("latitude"),
            "lon": body.get("Longitude") if body.get("Longitude") is not None else meta.get("longitude"),
            "sog": body.get("Sog"),
            "cog": body.get("Cog"),
            "heading": body.get("TrueHeading"),
            "nav_status": body.get("NavigationalStatus"),
            "draught_m": None,
            "raw": raw,
        }
        return NormalizedMessage(message_row=row, vessel_update=None)

    if mtype == "ShipStaticData":
        body = inner.get("ShipStaticData") or {}
        mmsi = int(body.get("UserID") or meta.get("MMSI") or 0)
        if mmsi == 0:
            return None
        dim = body.get("Dimension") or {}
        length = (dim.get("A") or 0) + (dim.get("B") or 0)
        beam = (dim.get("C") or 0) + (dim.get("D") or 0)
        draught = body.get("MaximumStaticDraught")
        row = {
            "ts": ts,
            "mmsi": mmsi,
            "msg_type": _STATIC_TYPE,
            "lat": None,
            "lon": None,
            "sog": None,
            "cog": None,
            "heading": None,
            "nav_status": None,
            "draught_m": draught,
            "raw": raw,
        }
        vessel = {
            "mmsi": mmsi,
            "imo": body.get("Imo") or None,
            "name": (body.get("Name") or "").strip() or None,
            "callsign": (body.get("CallSign") or "").strip() or None,
            "ship_type": body.get("Type"),
            "length_m": length or None,
            "beam_m": beam or None,
            "draught_m": draught,
            "ts": ts,
        }
        return NormalizedMessage(message_row=row, vessel_update=vessel)

    return None
