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
    # Paginate via $top + $skip. Each page is up to 100 scenes (CDSE
    # caps page size); a 90-day Hormuz window can return 150+.
    PAGE = 100
    HARD_CAP = 1000
    items: list[dict] = []
    skip = 0
    while skip < HARD_CAP:
        params = {
            "$filter": filt,
            "$orderby": "ContentDate/Start desc",
            "$top": str(PAGE),
            "$skip": str(skip),
        }
        url = f"{CDSE_ODATA}/Products"
        resp = requests.get(url, params=params, timeout=60)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"CDSE catalog query failed: {resp.status_code} {resp.text[:300]}"
            )
        page = resp.json().get("value", [])
        items.extend(page)
        if len(page) < PAGE:
            break
        skip += PAGE

    out: list[SarScene] = []
    for item in items:
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


# ── Stage 3: ship detection on a downloaded scene ────────────────────
#
# Approach: per-tile median + scaled MAD threshold, then connected-
# component clustering. Simpler than full 2D CFAR but highly effective
# on Sentinel-1 GRD imagery — ships are bright point sources on a
# locally-uniform sea background. MAD scaled by 1.4826 makes it ≈ σ
# for a normal noise model, so threshold = median + k × σ_robust.
#
# Why per-tile rather than per-image: SAR backscatter varies a lot
# across an IW swath (incidence-angle gradient, near/far range,
# patches of different sea state). A global threshold misses ships
# in low-backscatter regions and floods false positives in high-
# backscatter regions. Per-tile (4096 px ≈ 40 km) statistics adapt.
#
# Land filtering: not implemented in this pass. Coastline and ports
# will produce false-positive clusters. We rely on the bbox filter
# to drop most land hits and the area filter to drop islands. Future
# work: use the OSM coastline shape file to mask land pixels before
# detection.

import zipfile as _zipfile
import xml.etree.ElementTree as _ET


def _resolve_safe_paths(zip_path: Path) -> tuple[str, str, str]:
    """Return (vv_tiff_inside_zip, vv_annotation_inside_zip, root_safe)."""
    with _zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
    vv_tiff = next(
        n for n in names
        if "/measurement/" in n and "vv" in n.lower() and n.endswith(".tiff")
    )
    vv_anno = next(
        n for n in names
        if "/annotation/" in n
        and "/calibration/" not in n
        and "/rfi/" not in n
        and not n.rsplit("/", 1)[-1].startswith("rfi-")
        and "vv" in n.lower()
        and n.endswith(".xml")
    )
    return vv_tiff, vv_anno, names[0].split("/", 1)[0]


def _load_gcps(zip_path: Path, anno_xml: str) -> list[tuple[float, float, float, float]]:
    """Return [(pixel, line, lat, lon), ...] from the annotation XML."""
    with _zipfile.ZipFile(zip_path) as z:
        with z.open(anno_xml) as f:
            tree = _ET.parse(f)
    gcps = []
    for pt in tree.iter("geolocationGridPoint"):
        gcps.append((
            float(pt.find("pixel").text),
            float(pt.find("line").text),
            float(pt.find("latitude").text),
            float(pt.find("longitude").text),
        ))
    if not gcps:
        raise RuntimeError(f"no GCPs in annotation {anno_xml}")
    return gcps


def _make_pixel_to_latlon(gcps: list[tuple[float, float, float, float]]):
    """Return a callable f(px, py) -> (lat, lon)."""
    import numpy as np
    from scipy.interpolate import LinearNDInterpolator
    pts = np.array([(g[0], g[1]) for g in gcps])
    lats = np.array([g[2] for g in gcps])
    lons = np.array([g[3] for g in gcps])
    lat_i = LinearNDInterpolator(pts, lats)
    lon_i = LinearNDInterpolator(pts, lons)
    def f(px, py):
        return float(lat_i(px, py)), float(lon_i(px, py))
    return f


def _detect_in_tile(
    arr,
    *,
    k_sigma: float = 8.0,
    min_area: int = 10,
    max_area: int = 2000,
):
    """Threshold + connected components in a single tile.

    Returns list of (cy, cx, area, length_px, width_px) in tile-local
    coordinates. Caller adds tile offset to get image-global coords.
    """
    import numpy as np
    from scipy.ndimage import label, find_objects

    a = arr.astype(np.float32)
    med = float(np.median(a))
    mad = float(np.median(np.abs(a - med)))
    if mad < 1e-6:
        return []  # blank tile (off-edge or degenerate)
    threshold = med + k_sigma * 1.4826 * mad
    mask = a > threshold
    labeled, _n = label(mask)
    out = []
    for i, sl in enumerate(find_objects(labeled)):
        if sl is None:
            continue
        comp = labeled[sl] == (i + 1)
        area = int(comp.sum())
        if area < min_area or area > max_area:
            continue
        ys, xs = np.where(comp)
        cy = sl[0].start + float(ys.mean())
        cx = sl[1].start + float(xs.mean())
        length_px = sl[0].stop - sl[0].start
        width_px = sl[1].stop - sl[1].start
        out.append((cy, cx, area, length_px, width_px))
    return out


def detect_ships_in_zip(
    zip_path: Path,
    bbox: tuple[float, float, float, float],
    *,
    scene_id: str | None = None,
    acquired_at: datetime | None = None,
    tile: int = 4096,
    k_sigma: float = 8.0,
    min_length_m: float = 50.0,
) -> list[SarDetection]:
    """Run ship detection over a downloaded .SAFE.zip GRD product.

    Streams the scene tile-by-tile via /vsizip so we never load all
    519 megapixels at once. Each detection is geocoded via the
    annotation XML's GCPs and filtered to `bbox`. Returns a list
    of `SarDetection` with `likely_tanker=False` — call
    `filter_tanker_class` to mark hulls >= 180 m.
    """
    import numpy as np
    import rasterio

    lat_min, lat_max, lon_min, lon_max = bbox
    vv_tiff, vv_anno, _root = _resolve_safe_paths(zip_path)
    gcps = _load_gcps(zip_path, vv_anno)
    pixel_to_latlon = _make_pixel_to_latlon(gcps)

    if scene_id is None:
        scene_id = zip_path.stem.replace(".SAFE", "")
    if acquired_at is None:
        acquired_at = datetime.now(timezone.utc)

    vsizip = f"/vsizip/{zip_path}/{vv_tiff}"
    detections: list[SarDetection] = []
    with rasterio.open(vsizip) as ds:
        H, W = ds.height, ds.width
        logger.info("sar: scanning %dx%d (%.0f MP) in %dpx tiles",
                    W, H, W * H / 1e6, tile)
        for row_off in range(0, H, tile):
            row_end = min(row_off + tile, H)
            for col_off in range(0, W, tile):
                col_end = min(col_off + tile, W)
                arr = ds.read(
                    1,
                    window=((row_off, row_end), (col_off, col_end)),
                )
                if arr.size == 0:
                    continue
                hits = _detect_in_tile(arr, k_sigma=k_sigma)
                for cy, cx, area, length_px, width_px in hits:
                    px = col_off + cx
                    py = row_off + cy
                    lat, lon = pixel_to_latlon(px, py)
                    if not (np.isfinite(lat) and np.isfinite(lon)):
                        continue
                    if not (lat_min <= lat <= lat_max and lon_min <= lon <= lon_max):
                        continue
                    length_m = float(max(length_px, width_px) * 10)
                    if length_m < min_length_m:
                        # Drops most speckle/wave/small-fishing-vessel noise.
                        # 50 m floor matches a small coaster — the smallest
                        # commercial vessel we care about for oil flow.
                        continue
                    detections.append(SarDetection(
                        scene_id=scene_id,
                        detected_at=acquired_at,
                        lat=lat,
                        lon=lon,
                        length_m=length_m,
                        width_m=float(min(length_px, width_px) * 10),
                        intensity=float(area),
                        likely_tanker=False,
                    ))
    logger.info("sar: %d raw detections in %s", len(detections), scene_id)
    detections = _filter_at_sea(detections)
    logger.info("sar: %d detections after land mask in %s", len(detections), scene_id)
    return detections


def _filter_at_sea(detections: list[SarDetection]) -> list[SarDetection]:
    """Drop detections that fall on land using the NOAA GSHHG land
    mask. Coastline backscatter and inland-water false positives
    (river deltas, refineries, ports) dominate raw SAR output;
    masking land removes ~95 % of them in the Persian Gulf.

    The mask is coarse (~1 km resolution at this latitude), so a
    detection within ~1 km of shore may still be marked as sea —
    those are mostly real anchored vessels and dockside tankers.
    """
    if not detections:
        return detections
    try:
        from global_land_mask import globe
    except ImportError:
        logger.warning("global_land_mask not installed — skipping land filter")
        return detections
    return [d for d in detections if not bool(globe.is_land(d.lat, d.lon))]


def detect_ships(
    scene_path: Path,
    bbox: tuple[float, float, float, float],
    *,
    pfa: float = 1e-6,
    guard_window: int = 7,
    train_window: int = 21,
) -> list[SarDetection]:
    """Compatibility shim — orchestrator calls this name. Routes to
    `detect_ships_in_zip`. The pfa/guard/train kwargs from the
    original CFAR signature are accepted but unused; the
    implementation is the simpler median+MAD detector that performs
    well on GRD imagery for our use case."""
    return detect_ships_in_zip(scene_path, bbox)


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
    """Replace sar_detections rows for these scene_ids with the new
    set. Keeps re-running the detector idempotent — if we tune the
    threshold and re-process the same scene, old (now-stale) rows
    don't pile up alongside the new ones."""
    rows = list(detections)
    if not rows:
        return 0
    scene_ids = {d.scene_id for d in rows}
    for sid in scene_ids:
        con.execute("DELETE FROM sar_detections WHERE scene_id = ?", [sid])
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
