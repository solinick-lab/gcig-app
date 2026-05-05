from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

import websockets

logger = logging.getLogger(__name__)

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"


def build_subscribe_message(
    api_key: str, bbox: tuple[float, float, float, float]
) -> str:
    lat_min, lat_max, lon_min, lon_max = bbox
    return json.dumps({
        "APIKey": api_key,
        "BoundingBoxes": [[[lat_min, lon_min], [lat_max, lon_max]]],
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })


async def _connect(url: str):
    return websockets.connect(url, ping_interval=20, ping_timeout=20)


class AISStreamClient:
    def __init__(self, api_key: str, bbox: tuple[float, float, float, float]):
        self._api_key = api_key
        self._bbox = bbox

    async def stream(self) -> AsyncIterator[dict[str, Any]]:
        backoff = 1.0
        sub = build_subscribe_message(self._api_key, self._bbox)
        while True:
            try:
                ctx = await _connect(AISSTREAM_URL)
                async with ctx as ws:
                    await ws.send(sub)
                    backoff = 1.0
                    async for raw in ws:
                        try:
                            yield json.loads(raw)
                        except json.JSONDecodeError:
                            logger.warning("undecodable AIS frame: %r", raw[:200])
            except (ConnectionError, OSError, websockets.WebSocketException) as e:
                logger.warning("AISStream error: %s; reconnecting in %.1fs", e, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
