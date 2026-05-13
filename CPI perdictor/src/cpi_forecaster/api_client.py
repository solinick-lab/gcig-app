"""Authenticated client for gcig-api.

The forecaster talks to ONE upstream: the gcig-api Render service. All
external API keys (FRED especially) live on Render, never on this host.

HMAC scheme — must match server/src/routes/cpi.js verifyHmac():
    message = f"{timestamp}.{path}.".encode() + raw_body
    signature = hex(HMAC_SHA256(CPI_INGEST_SECRET, message))

`path` is the URL path the request is sent to (e.g. '/api/cpi/ingest'),
bound into the signature so an interceptor can't replay a sig captured
from one endpoint against a different endpoint.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any

import requests


def _config() -> tuple[str, str]:
    api_url = os.environ.get("GCIG_API_URL", "").rstrip("/")
    secret = os.environ.get("CPI_INGEST_SECRET", "")
    if not api_url:
        raise RuntimeError("GCIG_API_URL not set (e.g. https://gcig-api.onrender.com)")
    if not secret:
        raise RuntimeError("CPI_INGEST_SECRET not set")
    return api_url, secret


def _sign(secret: str, timestamp: str, path: str, body: bytes) -> str:
    msg = f"{timestamp}.{path}.".encode("ascii") + body
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _signed_headers(secret: str, path: str, body: bytes) -> dict[str, str]:
    ts = str(int(time.time()))
    return {
        "X-CPI-Timestamp": ts,
        "X-CPI-Signature": _sign(secret, ts, path, body),
    }


def get_fred_panel() -> dict[str, Any]:
    """GET /api/cpi/fred-panel — server pulls from FRED, returns aligned panel."""
    api_url, secret = _config()
    path = "/api/cpi/fred-panel"
    headers = _signed_headers(secret, path, b"")
    resp = requests.get(f"{api_url}{path}", headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"fred-panel GET failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def get_daily_panel() -> dict[str, Any]:
    """GET /api/cpi/daily-panel — raw daily series (no monthly aggregation).

    Returns:
        {
          "fetchedAt": ISO,
          "daily":  { SERIES_ID: [{date, value}, ...] },
          "weekly": { SERIES_ID: [{date, value}, ...] },
        }
    """
    api_url, secret = _config()
    path = "/api/cpi/daily-panel"
    headers = _signed_headers(secret, path, b"")
    resp = requests.get(f"{api_url}{path}", headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"daily-panel GET failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def get_cleveland_nowcast() -> dict:
    """GET /api/cpi/cleveland-nowcast — Cleveland Fed inflation nowcast scrape.

    Server fetches the public Cleveland Fed page's underlying JSON feeds
    and returns the latest headline/core MoM and YoY values for current
    and next months. Shape:

        {
          "ok": bool,
          "fetchedAt": ISO,
          "asOfDate": "YYYY-MM-DD" | None,
          "headline": {
            "currentMonth": {"yoy": float, "mom": float, "month": "YYYY-MM"},
            "nextMonth":    {"yoy": float, "mom": float, "month": "YYYY-MM"},
          },
          "core": { ... },
        }

    On scrape failure the server still returns 200 with `ok: false` and
    empty `headline`/`core` dicts. Caller should fall back to FRED median
    CPI proxy in that case.
    """
    api_url, secret = _config()
    path = "/api/cpi/cleveland-nowcast"
    headers = _signed_headers(secret, path, b"")
    try:
        resp = requests.get(f"{api_url}{path}", headers=headers, timeout=30)
    except Exception as exc:
        # Total network failure — return the same empty shape the server
        # would emit so callers have a single code path.
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "headline": {},
            "core": {},
            "error": f"network: {exc}",
        }
    if resp.status_code >= 400:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "headline": {},
            "core": {},
            "error": f"http {resp.status_code}: {resp.text[:200]}",
        }
    try:
        return resp.json()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "headline": {},
            "core": {},
            "error": f"json: {exc}",
        }


def get_zillow_rent() -> dict:
    """GET /api/cpi/zillow-rent — Zillow Observed Rent Index (ZORI) feed.

    Server fetches Zillow Research's national ZORI CSV and returns the
    trailing ~36 months of monthly observations annotated with YoY/MoM
    percent changes. Shape:

        {
          "ok": bool,
          "fetchedAt": ISO,
          "source": "zillow_zori" | "case_shiller" | None,
          "usedFallback": bool,
          "history": [{"date": "YYYY-MM-DD", "level": float,
                       "yoy": float, "mom": float}, ...],
        }

    `source` reports which upstream actually answered. If Zillow's CSV is
    unreachable the server falls back to FRED Case-Shiller (a weaker proxy
    for housing momentum) and flips `usedFallback` to True. On total
    failure the server still responds 200 with `ok: false` and an empty
    `history`, so callers always get a single shape to handle.
    """
    api_url, secret = _config()
    path = "/api/cpi/zillow-rent"
    headers = _signed_headers(secret, path, b"")
    try:
        resp = requests.get(f"{api_url}{path}", headers=headers, timeout=45)
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "source": None,
            "usedFallback": False,
            "history": [],
            "error": f"network: {exc}",
        }
    if resp.status_code >= 400:
        return {
            "ok": False,
            "fetchedAt": "",
            "source": None,
            "usedFallback": False,
            "history": [],
            "error": f"http {resp.status_code}: {resp.text[:200]}",
        }
    try:
        return resp.json()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "source": None,
            "usedFallback": False,
            "history": [],
            "error": f"json: {exc}",
        }


def get_truflation_feed() -> dict:
    """GET /api/cpi/truflation — Truflation US CPI daily index scrape.

    Truflation publishes a daily-updated, blockchain-verified US inflation
    index. Server fetches their public Nuxt-proxied endpoints (no key
    needed) and returns latest YoY/MoM and the full daily history.
    Response shape:

        {
          "ok": bool,
          "fetchedAt": ISO,
          "asOfDate": "YYYY-MM-DD" | None,
          "yoy": float | None,    # latest YoY percent (e.g. 1.81)
          "mom": float | None,    # latest MoM percent (computed from level)
          "history": [{"date": "YYYY-MM-DD", "yoy": float}, ...],
          "seriesYoy":   { "YYYY-MM-DD": yoy%, ... },   # full daily series
          "seriesLevel": { "YYYY-MM-DD": level, ... },  # full daily series
        }

    On scrape failure the server still returns 200 with `ok: false` and
    empty fields. Caller should fall back gracefully.
    """
    api_url, secret = _config()
    path = "/api/cpi/truflation"
    headers = _signed_headers(secret, path, b"")
    try:
        resp = requests.get(f"{api_url}{path}", headers=headers, timeout=45)
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "yoy": None,
            "mom": None,
            "history": [],
            "seriesYoy": {},
            "seriesLevel": {},
            "error": f"network: {exc}",
        }
    if resp.status_code >= 400:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "yoy": None,
            "mom": None,
            "history": [],
            "seriesYoy": {},
            "seriesLevel": {},
            "error": f"http {resp.status_code}: {resp.text[:200]}",
        }
    try:
        return resp.json()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "yoy": None,
            "mom": None,
            "history": [],
            "seriesYoy": {},
            "seriesLevel": {},
            "error": f"json: {exc}",
        }


def post_forecast(payload: dict[str, Any]) -> dict:
    """POST /api/cpi/ingest — upsert this run by asOfMonth."""
    api_url, secret = _config()
    path = "/api/cpi/ingest"
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        **_signed_headers(secret, path, body),
    }
    # 60s timeout because Render starter-tier services can take 30-60s to
    # wake from idle. The POST itself is fast once the server is awake.
    resp = requests.post(f"{api_url}{path}", data=body, headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"ingest POST failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()
