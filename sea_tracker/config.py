from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    aisstream_api_key: str
    bbox: tuple[float, float, float, float]  # lat_min, lat_max, lon_min, lon_max
    db_path: Path
    parquet_dir: Path
    log_dir: Path


def load_config(path: Path) -> Config:
    if not path.exists():
        raise FileNotFoundError(path)
    with path.open("rb") as f:
        data = tomllib.load(f)

    return Config(
        aisstream_api_key=data["aisstream"]["api_key"],
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
