from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
import time
from datetime import date, datetime, timedelta
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


def _open_db(cfg) -> "duckdb.DuckDBPyConnection":
    con = connect(cfg.db_path)
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
def collect(config: Path = typer.Option(Path("config.toml"), "--config", "-c")) -> None:
    """Run the live AIS collector (foreground)."""
    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "collect")
    api_key = _resolve_aisstream_key(cfg)
    client = AISStreamClient(api_key=api_key, bbox=cfg.bbox)
    asyncio.run(run_collector(client, cfg.db_path))


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
        end = date.today()
        start = end - timedelta(days=days)
        compute_signals_range(con, start_day=start, end_day=end)
        console.print(f"computed signals {start} → {end}")
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
    con = _open_db(cfg)
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
    con = _open_db(cfg)
    try:
        now = datetime.utcnow()
        out = publish_snapshot_now(con, bbox=cfg.bbox, now=now)
        console.print(out)
    finally:
        con.close()


if __name__ == "__main__":
    app()
