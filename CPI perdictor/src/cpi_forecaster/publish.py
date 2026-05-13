"""POST the forecast payload to gcig-api.

Thin wrapper around api_client.post_forecast. Kept as its own module so
cli.py imports stay readable.
"""

from __future__ import annotations

from typing import Any

from .api_client import post_forecast as _post


def post_forecast(payload: dict[str, Any]) -> dict:
    return _post(payload)
