from __future__ import annotations

import os
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


def _load_env_file(env_path: Path) -> None:
    """Tiny .env loader. Pulls KEY=value lines into os.environ if they
    aren't already set. We avoid adding python-dotenv as a runtime
    dep since the format we use is trivial — no quoting, no exports,
    no interpolation. Existing process env wins, so a value set by
    NSSM or Task Scheduler is never clobbered."""
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def load_config(path: Path) -> Config:
    if not path.exists():
        raise FileNotFoundError(path)
    # Look for a sibling .env (same directory as config.toml). Lets
    # operators keep secrets out of config.toml without standing up a
    # whole settings framework. Lines: KEY=value, comments with #.
    _load_env_file(path.with_name(".env"))
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
