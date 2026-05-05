"""Diagnostic probe for the AISStream feed.

Stand-alone script that mirrors what the collector does — load the
same config, resolve the same API key, subscribe to the same bbox —
and reports raw throughput over a fixed window. Use it when the
collector appears silent or nearly so: it bypasses every line of our
own ingest pipeline (normalize, DB, publish) so the result tells you
unambiguously whether the upstream feed is delivering or not.

Usage on the Windows server:

    nssm stop sea_tracker_collect
    .venv\\Scripts\\python -m sea_tracker.probe -c C:\\sea_tracker\\config.toml
    nssm start sea_tracker_collect

The collector is stopped first because AISStream may rate-limit per
API key and a second concurrent subscription can starve the running
collector. Restart it after the probe finishes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import websockets

from sea_tracker.ais_client import AISSTREAM_URL, build_subscribe_message
from sea_tracker.config import load_config


async def _run(config_path: Path, duration_s: float) -> None:
    cfg = load_config(config_path)

    if cfg.aisstream_api_key:
        api_key = cfg.aisstream_api_key
        print(f"[probe] using key from config.toml (len {len(api_key)})")
    else:
        # Defer the import so the probe still works on a box that
        # hasn't installed `requests` for some reason.
        from sea_tracker.api_client import get_aisstream_key

        print("[probe] fetching key from Render via /api/sea/secrets...")
        api_key = get_aisstream_key()
        print(f"[probe] fetched key (len {len(api_key)})")

    print(f"[probe] bbox: {cfg.bbox}")
    print(f"[probe] connecting to {AISSTREAM_URL} ...")

    sub = build_subscribe_message(api_key, cfg.bbox)

    msg_types: Counter[str] = Counter()
    mmsis: set[int] = set()
    first_frames: list[dict] = []
    total = 0
    started_at = datetime.now(timezone.utc)
    first_message_at: datetime | None = None
    last_message_at: datetime | None = None

    try:
        async with websockets.connect(
            AISSTREAM_URL, ping_interval=20, ping_timeout=20
        ) as ws:
            print("[probe] connected. sending subscribe...")
            await ws.send(sub)
            print(f"[probe] listening for {duration_s:.0f}s ...")
            try:
                async with asyncio.timeout(duration_s):
                    async for raw in ws:
                        now = datetime.now(timezone.utc)
                        if first_message_at is None:
                            first_message_at = now
                            print(f"[probe] first frame at +{(now - started_at).total_seconds():.1f}s")
                        last_message_at = now
                        total += 1
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            msg_types["__undecodable__"] += 1
                            continue
                        mtype = msg.get("MessageType", "__missing__")
                        msg_types[mtype] += 1
                        meta = msg.get("MetaData") or {}
                        mmsi = meta.get("MMSI")
                        if isinstance(mmsi, int):
                            mmsis.add(mmsi)
                        if len(first_frames) < 3:
                            first_frames.append(msg)
            except asyncio.TimeoutError:
                pass
    except Exception as exc:
        print(f"[probe] ERROR during stream: {type(exc).__name__}: {exc}")

    elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
    print()
    print("=" * 60)
    print("RESULTS")
    print("=" * 60)
    print(f"elapsed:      {elapsed:.1f}s")
    print(f"total frames: {total}")
    print(f"unique MMSI:  {len(mmsis)}")
    print(f"msg/sec:      {total / elapsed:.2f}")
    if first_message_at:
        print(f"first frame:  +{(first_message_at - started_at).total_seconds():.1f}s")
    if last_message_at:
        print(f"last frame:   +{(last_message_at - started_at).total_seconds():.1f}s")
    print()
    print("message-type counts:")
    for mt, n in msg_types.most_common():
        print(f"  {mt:30s} {n}")

    if first_frames:
        print()
        print("first 3 frames (truncated to 400 chars each):")
        for i, f in enumerate(first_frames, 1):
            s = json.dumps(f, default=str)[:400]
            print(f"  [{i}] {s}")
    elif total == 0:
        print()
        print("NO FRAMES RECEIVED. Likely causes:")
        print("  1. AISStream rejected the API key (silent — they don't error).")
        print("  2. AISStream rejected the bbox subscription (also silent).")
        print("  3. Free-tier fair-use throttle has cut us off.")
        print("  4. Network egress on this box is blocking wss://stream.aisstream.io.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "-c",
        "--config",
        type=Path,
        default=Path("config.toml"),
        help="Path to config.toml (same one the collector uses).",
    )
    parser.add_argument(
        "-d",
        "--duration",
        type=float,
        default=30.0,
        help="Seconds to listen before reporting (default: 30).",
    )
    args = parser.parse_args()
    asyncio.run(_run(args.config, args.duration))


if __name__ == "__main__":
    main()
