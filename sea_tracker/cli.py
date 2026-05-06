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


@app.command("sar-clear")
def sar_clear(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
) -> None:
    """Wipe the sar_detections table. Use before reprocessing a
    different region so the map only shows current detections."""
    cfg = load_config(config)
    con = _open_db(cfg)
    try:
        n = con.execute("SELECT COUNT(*) FROM sar_detections").fetchone()[0]
        con.execute("DELETE FROM sar_detections")
        console.print(f"deleted {n} rows from sar_detections")
    finally:
        con.close()


@app.command("sar-detect-one")
def sar_detect_one(
    scene_id: str = typer.Argument(..., help="Scene UUID (must already be downloaded)."),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    out_dir: Path = typer.Option(
        Path("C:/sea_tracker/sar"),
        "--out-dir",
        help="Where downloaded GRD products live.",
    ),
    bbox: str = typer.Option(
        "",
        "--bbox", "-b",
        help="Restrict detection to lat_min,lat_max,lon_min,lon_max (defaults to config bbox).",
    ),
) -> None:
    """Detect ships in a single already-downloaded scene and print
    a summary. Doesn't persist — use `sar-detect` for the orchestrated
    end-to-end pipeline that writes to sar_detections."""
    from sea_tracker.sar import (
        SarDetection,
        detect_ships_in_zip,
        filter_tanker_class,
    )

    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "sar")
    zip_path = out_dir / f"{scene_id}.SAFE.zip"
    if not zip_path.exists():
        console.print(f"[red]scene not on disk: {zip_path}[/red]")
        console.print("Run sar-download first.")
        raise typer.Exit(code=1)

    if bbox:
        parts = [float(x) for x in bbox.split(",")]
        if len(parts) != 4:
            console.print("[red]--bbox must be lat_min,lat_max,lon_min,lon_max[/red]")
            raise typer.Exit(code=1)
        active_bbox = (parts[0], parts[1], parts[2], parts[3])
        console.print(f"using custom bbox: {active_bbox}")
    else:
        active_bbox = cfg.bbox

    raw = detect_ships_in_zip(zip_path, active_bbox, scene_id=scene_id)
    marked = filter_tanker_class(raw)
    tankers = [d for d in marked if d.likely_tanker]
    console.print(f"total detections in bbox: {len(marked)}")
    console.print(f"  tanker-class (>=180 m): {len(tankers)}")
    console.print(f"  smaller hulls:          {len(marked) - len(tankers)}")

    # Persist into sar_detections so the snapshot pipeline can fold
    # them into the React map. Idempotent on (scene_id, lat, lon).
    from sea_tracker.sar import persist
    con = _open_db(cfg)
    try:
        n = persist(con, marked)
        console.print(f"persisted {n} detections to sar_detections")
    finally:
        con.close()

    if marked:
        console.print("\nfirst 8 detections:")
        for d in marked[:8]:
            tag = "TANKER" if d.likely_tanker else "small "
            console.print(
                f"  {tag} lat={d.lat:.4f} lon={d.lon:.4f} "
                f"length={int(d.length_m)}m width={int(d.width_m)}m area={int(d.intensity)}px"
            )


@app.command("sar-daily")
def sar_daily(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    out_dir: Path = typer.Option(
        Path("C:/sea_tracker/sar"),
        "--out-dir",
        help="Where downloaded GRD products live.",
    ),
    bbox: str = typer.Option(
        "25.0,27.5,55.5,57.5",
        "--bbox", "-b",
        help="Detection bbox: lat_min,lat_max,lon_min,lon_max. Default = Hormuz strait + approaches.",
    ),
    lookback_days: int = typer.Option(3, "--lookback", help="How many days of catalog to scan."),
    max_scenes: int = typer.Option(
        4, "--max-scenes",
        help="Cap how many new scenes per run. First-time runs would otherwise pull 20+ × ~2 GB.",
    ),
    prune_days: int = typer.Option(
        14, "--prune-days",
        help="Delete GRD .SAFE.zip files older than this. Detections stay in DB.",
    ),
) -> None:
    """Daily SAR pipeline: catalog → download new → detect → persist → prune.

    Designed to run unattended from Task Scheduler after the rest of
    the daily batch (so it benefits from the collector being stopped
    and the DuckDB writer being free). Idempotent — already-processed
    scenes are skipped, already-downloaded files are reused.
    """
    from sea_tracker.sar import (
        _missing_credentials,
        detect_ships_in_zip,
        download_scene,
        filter_tanker_class,
        find_recent_scenes,
        persist,
    )

    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "sar")

    missing = _missing_credentials()
    if missing:
        console.print(f"[yellow]skipping sar-daily: {missing} not set[/yellow]")
        return

    parts = [float(x) for x in bbox.split(",")]
    if len(parts) != 4:
        console.print("[red]--bbox must be lat_min,lat_max,lon_min,lon_max[/red]")
        raise typer.Exit(code=1)
    active_bbox = (parts[0], parts[1], parts[2], parts[3])

    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Catalog query
    scenes = find_recent_scenes(active_bbox, days=lookback_days)
    console.print(f"sar-daily: {len(scenes)} catalog scenes in last {lookback_days} d")

    # 2. Filter to scenes not already in our DB
    con = _open_db(cfg)
    try:
        new_scenes = []
        for s in scenes:
            already = con.execute(
                "SELECT COUNT(*) FROM sar_detections WHERE scene_id = ?",
                [s.id],
            ).fetchone()[0]
            if already > 0:
                continue
            new_scenes.append(s)
            if len(new_scenes) >= max_scenes:
                break
        console.print(f"sar-daily: {len(new_scenes)} new scenes to process this run "
                      f"(cap {max_scenes})")

        # 3. Process each new scene
        total_dets = 0
        for s in new_scenes:
            try:
                zip_path = download_scene(s, out_dir)
            except Exception as exc:
                console.print(f"[yellow]sar-daily: download failed for {s.id}: {exc}[/yellow]")
                continue
            try:
                raw = detect_ships_in_zip(zip_path, active_bbox,
                                          scene_id=s.id, acquired_at=s.acquired_at)
            except Exception as exc:
                console.print(f"[yellow]sar-daily: detection failed for {s.id}: {exc}[/yellow]")
                continue
            marked = filter_tanker_class(raw)
            persist(con, marked)
            total_dets += len(marked)
            console.print(f"  {s.id}  acquired={s.acquired_at:%Y-%m-%d %H:%M}  detections={len(marked)}")
        console.print(f"sar-daily: persisted {total_dets} detections across "
                      f"{len(new_scenes)} scenes")
    finally:
        con.close()

    # 4. Prune old GRD products
    cutoff = datetime.now(timezone.utc) - timedelta(days=prune_days)
    pruned = 0
    pruned_bytes = 0
    for p in out_dir.glob("*.SAFE.zip"):
        try:
            mtime = datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if mtime < cutoff:
            sz = p.stat().st_size
            try:
                p.unlink()
                pruned += 1
                pruned_bytes += sz
            except OSError as exc:
                console.print(f"[yellow]sar-daily: prune failed {p}: {exc}[/yellow]")
    if pruned:
        console.print(f"sar-daily: pruned {pruned} GRD files "
                      f"({pruned_bytes / 1024 / 1024 / 1024:.1f} GB)")


@app.command("sar-backfill")
def sar_backfill(
    start: str = typer.Option(..., "--start", help="YYYY-MM-DD inclusive."),
    end: str = typer.Option(..., "--end", help="YYYY-MM-DD inclusive."),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
    out_dir: Path = typer.Option(
        Path("C:/sea_tracker/sar"),
        "--out-dir",
        help="Where downloaded GRD products are temporarily cached.",
    ),
    bbox: str = typer.Option(
        "25.0,27.5,55.5,57.2",
        "--bbox", "-b",
        help="Detection bbox.",
    ),
    max_scenes: int = typer.Option(
        6, "--max-scenes",
        help="How many scenes to process THIS run. Run again to continue backfilling.",
    ),
    keep_imagery: bool = typer.Option(
        False, "--keep-imagery/--delete-imagery",
        help="By default delete each .SAFE.zip after detection — backfill is detection-only.",
    ),
) -> None:
    """Backfill SAR detections over a historical date range.

    Use case: build a pre-event baseline so the strait/Iran cards
    have something to compare against. Idempotent — already-processed
    scenes are skipped, so multiple runs against the same window
    safely continue where the previous one stopped.

    Imagery is deleted after each scene by default (each GRD is ~2 GB
    and we don't need to keep them for backfill — just the detections
    in DuckDB).
    """
    from datetime import datetime as _dt
    from sea_tracker.sar import (
        _missing_credentials,
        detect_ships_in_zip,
        download_scene,
        filter_tanker_class,
        find_recent_scenes,
        persist,
    )

    cfg = load_config(config)
    _setup_logging(cfg.log_dir, "sar")
    missing = _missing_credentials()
    if missing:
        console.print(f"[red]Missing env var: {missing}[/red]")
        raise typer.Exit(code=1)

    parts = [float(x) for x in bbox.split(",")]
    if len(parts) != 4:
        console.print("[red]--bbox must be lat_min,lat_max,lon_min,lon_max[/red]")
        raise typer.Exit(code=1)
    active_bbox = (parts[0], parts[1], parts[2], parts[3])

    try:
        start_dt = _dt.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        end_dt = _dt.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc) + timedelta(days=1)
    except ValueError as exc:
        console.print(f"[red]Date format must be YYYY-MM-DD: {exc}[/red]")
        raise typer.Exit(code=1)

    # find_recent_scenes is implemented as `now - days .. now`. We
    # parameterise it via `now` and a synthetic days span to query
    # any historical window.
    days = int((end_dt - start_dt).total_seconds() // 86400)
    if days < 1:
        console.print("[red]end must be on/after start[/red]")
        raise typer.Exit(code=1)

    out_dir.mkdir(parents=True, exist_ok=True)

    scenes = find_recent_scenes(active_bbox, days=days, now=end_dt)
    console.print(f"sar-backfill: catalog returned {len(scenes)} scenes "
                  f"between {start} and {end}")

    con = _open_db(cfg)
    try:
        new_scenes = []
        for s in scenes:
            already = con.execute(
                "SELECT COUNT(*) FROM sar_detections WHERE scene_id = ?",
                [s.id],
            ).fetchone()[0]
            if already > 0:
                continue
            new_scenes.append(s)
            if len(new_scenes) >= max_scenes:
                break
        console.print(f"sar-backfill: {len(new_scenes)} unprocessed scenes "
                      f"this run (cap {max_scenes})")

        total_dets = 0
        for i, s in enumerate(new_scenes, 1):
            console.print(f"  [{i}/{len(new_scenes)}] {s.acquired_at:%Y-%m-%d %H:%M}  "
                          f"{s.id[:36]}")
            try:
                zip_path = download_scene(s, out_dir)
            except Exception as exc:
                console.print(f"    [yellow]download failed: {exc}[/yellow]")
                continue
            try:
                raw = detect_ships_in_zip(
                    zip_path, active_bbox,
                    scene_id=s.id, acquired_at=s.acquired_at,
                )
            except Exception as exc:
                console.print(f"    [yellow]detection failed: {exc}[/yellow]")
                continue
            marked = filter_tanker_class(raw)
            persist(con, marked)
            total_dets += len(marked)
            tankers = sum(1 for d in marked if d.likely_tanker)
            console.print(f"    -> {len(marked)} detections, {tankers} tanker-class")
            if not keep_imagery:
                try:
                    zip_path.unlink()
                except OSError as exc:
                    console.print(f"    [yellow]could not delete imagery: {exc}[/yellow]")

        console.print(f"sar-backfill: {total_dets} detections added across "
                      f"{len(new_scenes)} scenes")
        if len(new_scenes) >= max_scenes:
            console.print(
                "[yellow]hit per-run cap — re-run the same command to "
                "continue backfilling.[/yellow]"
            )
    finally:
        con.close()


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
