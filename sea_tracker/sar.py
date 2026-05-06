"""Sentinel-1 SAR ship detection pipeline (scaffolding).

This module is the entry point for processing Copernicus Sentinel-1
radar imagery into ship detections that complement our terrestrial
AIS feed in waters AISStream can't see (Iran, Saudi, Kuwait, Iraq).

Pipeline stages (built in order):

  1. find_recent_scenes(bbox, days)     — STAC query Copernicus Data Space
  2. download_scene(scene, out_dir)     — pull GRD product
  3. detect_ships(scene_path, bbox)     — CFAR-based ship detection
  4. filter_tanker_class(detections)    — size filter (>180 m) for
                                          tanker-class hulls
  5. persist(con, detections)           — write to sar_detections table

The Copernicus Data Space catalog requires (free) registered
credentials. We read CDSE_USERNAME / CDSE_PASSWORD from env (or load
them out of the same .env file as the rest of the project).

Status: stage 1 scaffolding only. Stages 2-5 are stubbed; calling
them raises NotImplementedError so failures are loud, not silent.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import requests

logger = logging.getLogger(__name__)


# Copernicus Data Space OData catalog. We use OData (not STAC) because
# the OData catalog is the official documented interface for both
# product search and download, and the URL structure is stable.
CDSE_ODATA = "https://catalogue.dataspace.copernicus.eu/odata/v1"
CDSE_DOWNLOAD = "https://download.dataspace.copernicus.eu/odata/v1"

# OIDC token endpoint for the username/password grant. The cdse-public
# client ID is the standard public client for end-user auth.
CDSE_TOKEN_URL = (
    "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/"
    "protocol/openid-connect/token"
)
CDSE_CLIENT_ID = "cdse-public"


@dataclass(frozen=True)
class SarScene:
    """One Sentinel-1 GRD product covering our bbox."""
    id: str
    acquired_at: datetime
    href: str
    polarization: str  # e.g. "VV+VH"
    orbit_pass: str    # "ASCENDING" / "DESCENDING"


@dataclass(frozen=True)
class SarDetection:
    """One candidate ship detection from a SAR scene."""
    scene_id: str
    detected_at: datetime
    lat: float
    lon: float
    length_m: float | None
    width_m: float | None
    intensity: float        # CFAR statistic
    likely_tanker: bool     # passes the size filter


# ── Stage 2a: Catalog query ──────────────────────────────────────────

def _bbox_to_polygon_wkt(
    bbox: tuple[float, float, float, float],
) -> str:
    """OData expects a closed POLYGON in WKT, lon/lat order."""
    lat_min, lat_max, lon_min, lon_max = bbox
    return (
        f"POLYGON(({lon_min} {lat_min},{lon_max} {lat_min},"
        f"{lon_max} {lat_max},{lon_min} {lat_max},{lon_min} {lat_min}))"
    )


def find_recent_scenes(
    bbox: tuple[float, float, float, float],
    *,
    days: int = 14,
    now: datetime | None = None,
    product_type: str = "GRD",
) -> list[SarScene]:
    """Sentinel-1 scenes covering `bbox` in the last `days`.

    OData query — no auth required. We filter by:
      - collection name (SENTINEL-1)
      - product type (GRD)
      - sensor mode (IW — the standard Persian Gulf coverage mode)
      - acquisition time within the window
      - footprint intersects bbox

    Returns scenes sorted newest-first.
    """
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(days=days)
    poly = _bbox_to_polygon_wkt(bbox)

    # OData query string. Quoting matters — single quotes for string
    # literals, double quotes inside the query are not allowed.
    fmt = "%Y-%m-%dT%H:%M:%S.000Z"
    filt = (
        "Collection/Name eq 'SENTINEL-1' and "
        f"OData.CSC.Intersects(area=geography'SRID=4326;{poly}') and "
        f"ContentDate/Start gt {start.strftime(fmt)} and "
        f"ContentDate/Start lt {now.strftime(fmt)} and "
        "Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'productType' "
        f"and att/OData.CSC.StringAttribute/Value eq '{product_type}') and "
        "Attributes/OData.CSC.StringAttribute/any(att:att/Name eq 'operationalMode' "
        "and att/OData.CSC.StringAttribute/Value eq 'IW')"
    )
    params = {
        "$filter": filt,
        "$orderby": "ContentDate/Start desc",
        "$top": "20",
    }
    url = f"{CDSE_ODATA}/Products"
    resp = requests.get(url, params=params, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(
            f"CDSE catalog query failed: {resp.status_code} {resp.text[:300]}"
        )
    data = resp.json()
    out: list[SarScene] = []
    for item in data.get("value", []):
        # Attributes is a list of {Name, Value, ValueType}; we just
        # care about a few.
        attrs = {a["Name"]: a.get("Value") for a in (item.get("Attributes") or [])}
        acquired = item.get("ContentDate", {}).get("Start") or item.get("OriginDate")
        try:
            acquired_dt = datetime.fromisoformat(acquired.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            acquired_dt = now
        out.append(SarScene(
            id=item["Id"],
            acquired_at=acquired_dt,
            href=f"{CDSE_DOWNLOAD}/Products({item['Id']})/$value",
            polarization=str(attrs.get("polarisationChannels") or ""),
            orbit_pass=str(attrs.get("orbitDirection") or ""),
        ))
    return out


# ── Stage 2b: Auth + download ────────────────────────────────────────

def _get_access_token() -> str:
    """Exchange CDSE_USERNAME/PASSWORD for an OIDC access token.

    The token lifetime is short (10 min). We don't cache here — each
    download fetches a fresh token, which costs one round-trip per
    GRD pull and avoids stale-token edge cases on long downloads.
    """
    user = os.environ.get("CDSE_USERNAME")
    pw = os.environ.get("CDSE_PASSWORD")
    if not user or not pw:
        raise RuntimeError("CDSE_USERNAME and CDSE_PASSWORD must be set in env")
    resp = requests.post(
        CDSE_TOKEN_URL,
        data={
            "client_id": CDSE_CLIENT_ID,
            "username": user,
            "password": pw,
            "grant_type": "password",
        },
        timeout=30,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"CDSE auth failed: {resp.status_code} {resp.text[:300]}"
        )
    return resp.json()["access_token"]


def download_scene(scene: SarScene, out_dir: Path) -> Path:
    """Download the GRD product. Idempotent: skips if the file
    already exists on disk and is non-empty.

    Sentinel-1 GRD products are ~1 GB each. The CDSE download
    endpoint returns a ZIP that contains the .SAFE folder.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{scene.id}.SAFE.zip"
    if out_path.exists() and out_path.stat().st_size > 0:
        logger.info("sar: scene %s already downloaded", scene.id)
        return out_path

    token = _get_access_token()
    logger.info("sar: downloading %s -> %s", scene.id, out_path)
    with requests.get(
        scene.href,
        headers={"Authorization": f"Bearer {token}"},
        stream=True,
        timeout=600,
        allow_redirects=True,
    ) as r:
        if r.status_code >= 400:
            raise RuntimeError(
                f"CDSE download failed: {r.status_code} {r.text[:200]}"
            )
        tmp = out_path.with_suffix(".zip.part")
        with tmp.open("wb") as f:
            for chunk in r.iter_content(chunk_size=8 * 1024 * 1024):
                if chunk:
                    f.write(chunk)
        tmp.rename(out_path)
    return out_path


# ── Stage 3: CFAR ship detection ─────────────────────────────────────

def detect_ships(
    scene_path: Path,
    bbox: tuple[float, float, float, float],
    *,
    pfa: float = 1e-6,
    guard_window: int = 7,
    train_window: int = 21,
) -> list[SarDetection]:
    """Run a 2D Constant-False-Alarm-Rate detector across the scene.

    Returns one `SarDetection` per detected hull, geocoded to lat/lon.
    Land pixels are masked using the SAR product's incidence-angle
    band (sea pixels have a characteristic distribution; land is
    skipped).
    """
    raise NotImplementedError("Stage 3: CFAR detection — not built yet")


# ── Stage 4: Tanker-class filter ─────────────────────────────────────

# Tanker size classes — see classify.py. We treat anything >= 180 m
# as "tanker-class candidate" for SAR purposes. Sub-180 m hits are
# more often tugs, supply vessels, fishing trawlers, or coastal
# shipping; including them would flood the map with non-tanker
# noise.
_TANKER_LENGTH_THRESHOLD_M = 180.0


def filter_tanker_class(detections: Iterable[SarDetection]) -> list[SarDetection]:
    """Mark detections likely to be tanker-class hulls (>= 180 m).

    Returns a new list with `likely_tanker` set per detection.
    Doesn't drop short ones — the React layer can choose to render
    them dimmer rather than hide them.
    """
    out: list[SarDetection] = []
    for d in detections:
        is_tanker = d.length_m is not None and d.length_m >= _TANKER_LENGTH_THRESHOLD_M
        out.append(SarDetection(**{**d.__dict__, "likely_tanker": is_tanker}))
    return out


# ── Stage 5: Persistence ─────────────────────────────────────────────

def persist(con, detections: Iterable[SarDetection]) -> int:
    """Insert detections into sar_detections (idempotent on
    (scene_id, lat, lon))."""
    rows = list(detections)
    if not rows:
        return 0
    con.executemany(
        """
        INSERT INTO sar_detections
            (scene_id, detected_at, lat, lon, length_m, width_m,
             intensity, likely_tanker)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scene_id, lat, lon) DO NOTHING
        """,
        [
            (d.scene_id, d.detected_at, d.lat, d.lon, d.length_m,
             d.width_m, d.intensity, d.likely_tanker)
            for d in rows
        ],
    )
    return len(rows)


# ── End-to-end orchestrator ──────────────────────────────────────────

def run_once(
    con,
    *,
    bbox: tuple[float, float, float, float],
    out_dir: Path,
) -> dict:
    """Single-pass execution of the full pipeline. Idempotent: a
    scene that has already been processed is skipped. Designed to
    be called from a Task Scheduler entry every 24 h — most days
    will find no new scene and exit fast."""
    scenes = find_recent_scenes(bbox, days=14)
    if not scenes:
        logger.info("sar: no scenes in window")
        return {"scenes": 0, "detections": 0}

    n_scenes = 0
    n_dets = 0
    for s in scenes:
        already = con.execute(
            "SELECT COUNT(*) FROM sar_detections WHERE scene_id = ?",
            [s.id],
        ).fetchone()[0]
        if already > 0:
            logger.info("sar: skipping already-processed scene %s", s.id)
            continue
        path = download_scene(s, out_dir)
        raw = detect_ships(path, bbox)
        marked = filter_tanker_class(raw)
        n_dets += persist(con, marked)
        n_scenes += 1
    return {"scenes": n_scenes, "detections": n_dets}


def _missing_credentials() -> str | None:
    if not os.environ.get("CDSE_USERNAME"):
        return "CDSE_USERNAME"
    if not os.environ.get("CDSE_PASSWORD"):
        return "CDSE_PASSWORD"
    return None
