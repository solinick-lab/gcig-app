"""HMAC-signed client for gcig-api.

Single upstream: the gcig-api Render service. The AISStream key never
leaves this machine — only computed signals and rolling snapshots go
out, both authenticated with HMAC over (timestamp + path + body).

HMAC scheme — must match server/src/routes/sea.js verifyHmac():
    message = f"{timestamp}.{path}.".encode() + raw_body
    signature = hex(HMAC_SHA256(SEA_INGEST_SECRET, message))

`path` is bound into the signature so a captured /signals signature
can't be replayed against /snapshot inside the 5-min skew window.
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
    secret = os.environ.get("SEA_INGEST_SECRET", "")
    if not api_url:
        raise RuntimeError("GCIG_API_URL not set (e.g. https://gcig-api.onrender.com)")
    if not secret:
        raise RuntimeError("SEA_INGEST_SECRET not set")
    return api_url, secret


def _sign(secret: str, timestamp: str, path: str, body: bytes) -> str:
    msg = f"{timestamp}.{path}.".encode("ascii") + body
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _signed_headers(secret: str, path: str, body: bytes) -> dict[str, str]:
    ts = str(int(time.time()))
    return {
        "X-Sea-Timestamp": ts,
        "X-Sea-Signature": _sign(secret, ts, path, body),
    }


def get_aisstream_key() -> str:
    """GET /api/sea/secrets — fetch the AISStream API key from Render.

    Returns the raw key string. Raises RuntimeError on failure so the
    caller can decide whether to retry (collector boot) or give up.
    """
    api_url, secret = _config()
    path = "/api/sea/secrets"
    headers = _signed_headers(secret, path, b"")
    resp = requests.get(f"{api_url}{path}", headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"secrets GET failed: {resp.status_code} {resp.text[:200]}")
    data = resp.json()
    key = data.get("aisstreamApiKey")
    if not key:
        raise RuntimeError("Render returned no aisstreamApiKey")
    return key


def post_signals(rows: list[dict[str, Any]]) -> dict:
    """POST /api/sea/signals — bulk-upsert signal rows.

    Each row: {"date": "YYYY-MM-DD", "name": str, "value": float | None}.
    """
    api_url, secret = _config()
    path = "/api/sea/signals"
    body = json.dumps({"signals": rows}, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        **_signed_headers(secret, path, body),
    }
    # 60s timeout absorbs Render free-tier cold starts (30-60s).
    resp = requests.post(f"{api_url}{path}", data=body, headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"signals POST failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def post_snapshot(payload: dict[str, Any]) -> dict:
    """POST /api/sea/snapshot — upsert the singleton snapshot row."""
    api_url, secret = _config()
    path = "/api/sea/snapshot"
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        **_signed_headers(secret, path, body),
    }
    resp = requests.post(f"{api_url}{path}", data=body, headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"snapshot POST failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()
