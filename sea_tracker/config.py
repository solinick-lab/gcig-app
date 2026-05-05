from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    # Optional: when empty (or the placeholder), the collector fetches
    # the key from Render's /api/sea/secrets instead. Local override
    # exists for offline testing.
    aisstream_api_key: str | None
    bbox: tuple[float, float, float, float]  # lat_min, lat_max, lon_min, lon_max
    db_path: Path
    parquet_dir: Path
    log_dir: Path


_PLACEHOLDER = "REPLACE_ME_AISSTREAM_KEY"


def load_config(path: Path) -> Config:
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("rb") as f:
        data = tomllib.load(f)

    raw_key = (data.get("aisstream") or {}).get("api_key", "") or ""
    api_key: str | None = raw_key.strip()
    if not api_key or api_key == _PLACEHOLDER:
        api_key = None

    return Config(
        aisstream_api_key=api_key,
        bbox=(
            float(data["bbox"]["lat_min"]),
            float(data["bbox"]["lat_max"]),
            float(data["bbox"]["lon_min"]),
            float(data["bbox"]["lon_max"]),
        ),
        db_path=Path(data["storage"]["db_path"]).expanduser(),
        parquet_dir=Path(data["storage"]["parquet_dir"]).expanduser(),
        log_dir=Path(data["storage"]["log_dir"]).expanduser(),
    )
