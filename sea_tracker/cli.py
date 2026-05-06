from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import typer
from rich.console import Console
from rich.table import Table

from sea_tracker.ais_client import AISStreamClient
from sea_tracker.api_client import get_aisstream_key
from sea_tracker.backtest import run_backtest
from sea_tracker.collector import run_collector
from sea_tracker.config import load_config
from sea_tracker.db import connect, init_schema
from sea_tracker.enrich import run_enrich
from sea_tracker.health import collect_health, db_size_mb
from sea_tracker.prices import refresh_prices
from sea_tracker.report import render_report
from sea_tracker.publish import publish_signals_window, publish_snapshot_now
from sea_tracker.signals import compute_signals_range

app = typer.Typer(no_args_is_help=True, add_completion=False)
console = Console()


def _setup_logging(log_dir: Path, name: str) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_dir / f"{name}.log", maxBytes=10 * 1024 * 1024, backupCount=5
    )
    fmt = logging.Formatter('{"ts":"%(asctime)s","level":"%(levelname)s","name":"%(name)s","msg":"%(message)s"}')
    handler.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)


def _open_db(cfg, *, read_only: bool = False) -> "duckdb.DuckDBPyConnection":
    con = connect(cfg.db_path, read_only=read_only)
    if not read_only:
        init_schema(con)
    return con


def _resolve_aisstream_key(cfg) -> str:
    # If config.toml has a real key, prefer it (offline testing).
    if cfg.aisstream_api_key:
        return cfg.aisstream_api_key
    # Otherwise pull from Render. Retry with exponential backoff so a
    # transient outage or cold-start at boot doesn't sink the service —
    # NSSM will restart on hard failure anyway.
    delays = [5, 15, 30, 60, 120]
    last_err: Exception | None = None
    for attempt, wait in enumerate(delays, start=1):
        try:
            return get_aisstream_key()
        except Exception as exc:
            last_err = exc
            logging.getLogger(__name__).warning(
                "aisstream key fetch failed (attempt %d/%d): %s", attempt, len(delays), exc
            )
            if attempt < len(delays):
                time.sleep(wait)
    raise RuntimeError(f"could not fetch AISSTREAM key from Render: {last_err}")


@app.command()
def collect(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    publish_interval: float = typer.Option(
        120.0, "--publish-interval",
        help="Seconds between snapshot publishes. 0 disables in-process publishing.",
    ),
) -> None:
    """Run the live AIS collector (foreground).

    The collector also publishes a snapshot to gcig-api every
    `--publish-interval` seconds using its own DuckDB connection,
    because Windows DuckDB doesn't allow a second reader process
    while the writer is up.
    """
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "collect")
    api_key = _resolve_aisstream_key(cfg)
    client = AISStreamClient(api_key=api_key, bbox=cfg.bbox)

    callback = None
    if publish_interval > 0:
        def _publish(con):
            now = datetime.utcnow()
            publish_snapshot_now(con, bbox=cfg.bbox, now=now)
        callback = _publish

    asyncio.run(run_collector(
        client,
        cfg.db_path,
        publish_callback=callback,
        publish_interval_s=publish_interval,
    ))


@app.command()
def enrich(config: Path = typer.Option(Path("config.toml"), "--config", "-c")) -> None:
    """Rebuild vessels.size_class, transits, port_calls."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "batch")
    con = _open_db(cfg)
    try:
        out = run_enrich(con)
        console.print(out)
    finally:
        con.close()


@app.command()
def signals(
    days: int = typer.Option(30, "--days", "-d"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Compute signal panel for the last N days."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "batch")
    con = _open_db(cfg)
    try:
        # AIS timestamps in DuckDB are naive UTC, so signal day-windows
        # have to be UTC days too. date.today() would return the
        # server's local date (ET on the Windows box) and silently miss
        # data that's already in tomorrow's UTC bucket.
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=days)
        compute_signals_range(con, start_day=start, end_day=end)
        console.print(f"computed signals {start} -> {end}")
    finally:
        con.close()


@app.command()
def prices(
    refresh: bool = typer.Option(True, "--refresh/--no-refresh"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Refresh oil prices from yfinance."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "batch")
    con = _open_db(cfg)
    try:
        if refresh:
            n = refresh_prices(con)
            console.print(f"refreshed {n} price rows")
    finally:
        con.close()


@app.command()
def backtest(
    signal: str = typer.Option(..., "--signal", "-s"),
    target: str = typer.Option("BZ=F", "--target", "-t"),
    out: Path = typer.Option(Path("report.html"), "--out", "-o"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Run backtest for one signal × target and emit an HTML report."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "batch")
    con = _open_db(cfg)
    try:
        res = run_backtest(con, signal_name=signal, target=target)
        render_report(res, out_path=out)
        console.print(f"wrote {out}")
    finally:
        con.close()


@app.command()
def health(config: Path = typer.Option(Path("config.toml"), "--config", "-c")) -> None:
    """Print health snapshot."""
    cfg = load_config(config)
    con = _open_db(cfg)
    try:
        h = collect_health(con)
        h["db_size_mb"] = round(db_size_mb(cfg.db_path), 1)
        t = Table(title="sea_tracker health")
        t.add_column("metric"); t.add_column("value")
        for k, v in h.items():
            t.add_row(k, str(v))
        console.print(t)
    finally:
        con.close()


@app.command()
def export(
    day: str = typer.Option(..., "--date"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Snapshot one day's AIS messages to parquet."""
    cfg = load_config(config)
    con = _open_db(cfg)
    try:
        d = datetime.strptime(day, "%Y-%m-%d").date()
        out_dir = cfg.parquet_dir / day
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / "ais_messages.parquet"
        con.execute(
            f"COPY (SELECT * FROM ais_messages WHERE date = ?) TO '{out_file}' (FORMAT PARQUET)",
            [d],
        )
        console.print(f"wrote {out_file}")
    finally:
        con.close()


@app.command("publish-signals")
def publish_signals(
    days: int = typer.Option(90, "--days", "-d"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Read last N days from signals_daily and POST to gcig-api."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "publish")
    con = _open_db(cfg, read_only=True)
    try:
        out = publish_signals_window(con, days=days)
        console.print(out)
    finally:
        con.close()


@app.command("publish-snapshot")
def publish_snapshot(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Build and POST the rolling-latest vessel + signals snapshot."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "publish")
    con = _open_db(cfg, read_only=True)
    try:
        now = datetime.utcnow()
        out = publish_snapshot_now(con, bbox=cfg.bbox, now=now)
        console.print(out)
    finally:
        con.close()


@app.command("sar-find")
def sar_find(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    days: int = typer.Option(14, "--days", "-d"),
) -> None:
    """List Sentinel-1 GRD scenes covering the bbox in the last N
    days. No auth required, no download — pure catalog inspection."""
    from sea_tracker.sar import find_recent_scenes

    cfg = load_config(config)
    scenes = find_recent_scenes(cfg.bbox, days=days)
    if not scenes:
        console.print(f"No Sentinel-1 GRD scenes for bbox in last {days} days.")
        return
    t = Table(title=f"Sentinel-1 GRD scenes (last {days} days)")
    t.add_column("acquired (UTC)")
    t.add_column("orbit")
    t.add_column("pol")
    t.add_column("id (truncated)")
    for s in scenes:
        t.add_row(
            s.acquired_at.strftime("%Y-%m-%d %H:%M"),
            s.orbit_pass[:4],
            s.polarization[:5],
            s.id[:36],
        )
    console.print(t)


@app.command("sar-download")
def sar_download(
    scene_id: str = typer.Argument(..., help="Scene UUID from sar-find."),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    out_dir: Path = typer.Option(
        Path("C:/sea_tracker/sar"),
        "--out-dir",
        help="Where to cache downloaded GRD products.",
    ),
) -> None:
    """Download a single GRD scene by id. Useful for one-off testing
    before wiring up the full daily pipeline."""
    from sea_tracker.sar import (
        SarScene,
        _missing_credentials,
        download_scene,
        find_recent_scenes,
    )

    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "sar")
    missing = _missing_credentials()
    if missing:
        console.print(f"[red]Missing env var: {missing}[/red]")
        console.print(
            "Register at https://dataspace.copernicus.eu/ and add CDSE_USERNAME "
            "and CDSE_PASSWORD to C:/sea_tracker/.env"
        )
        raise typer.Exit(code=1)
    # Re-fetch the full record so we have the right href + metadata.
    candidates = find_recent_scenes(cfg.bbox, days=30)
    match = next((s for s in candidates if s.id == scene_id), None)
    if match is None:
        console.print(f"[red]Scene id {scene_id} not in last 30 days of catalog.[/red]")
        raise typer.Exit(code=1)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = download_scene(match, out_dir)
    size_mb = path.stat().st_size / (1024 * 1024)
    console.print(f"downloaded {path} ({size_mb:.1f} MB)")


@app.command("sar-detect")
def sar_detect(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    out_dir: Path = typer.Option(
        Path("C:/sea_tracker/sar"),
        "--out-dir",
        help="Where to cache downloaded GRD products.",
    ),
) -> None:
    """Run the full Sentinel-1 SAR ship-detection pipeline once.

    Looks for new scenes covering the bbox in the last 14 days,
    downloads, detects ships, and persists to sar_detections.
    Designed to run daily from Task Scheduler — most invocations
    find no new scene and return quickly. Stage-1+2 implemented;
    detect_ships still raises NotImplementedError until Stage 3.
    """
    from sea_tracker.sar import run_once, _missing_credentials

    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "sar")
    missing = _missing_credentials()
    if missing:
        console.print(f"[red]Missing env var: {missing}[/red]")
        console.print(
            "Register at https://dataspace.copernicus.eu/ and add CDSE_USERNAME "
            "and CDSE_PASSWORD to C:/sea_tracker/.env"
        )
        raise typer.Exit(code=1)
    con = _open_db(cfg)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        result = run_once(con, bbox=cfg.bbox, out_dir=out_dir)
        console.print(result)
    finally:
        con.close()


if __name__ == "__main__":
    app()
