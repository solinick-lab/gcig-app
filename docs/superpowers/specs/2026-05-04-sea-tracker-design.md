# Tanker Tracker — Design Spec

Date: 2026-05-04
Status: approved (per user, brainstorming session 2026-05-04)

## Goal

Surface the existing `sea_tracker/` Python pipeline (Persian Gulf tanker
AIS → daily oil-flow signals + live vessel positions) inside the gcig-app
React client at `/tankers`, without putting any external API keys, AIS
collector code, or DuckDB on Render.

The pipeline runs on a Windows server Thomas SSHs into from his mac.
Render's gcig-api becomes a dumb pipe: HMAC-authed ingest in, JWT-authed
read-out. Same architecture as the CPI forecaster.

## Surface

Two pieces in one page:

1. **Signal panel** — current value + 90-day sparkline + "as of" stamp
   for the seven daily signals already computed in
   `sea_tracker/signals.py` (Hormuz outbound laden count, outbound DWT
   proxy, inbound ballast count, six per-country terminal-departure
   counts, gulf laden/ballast ratio, anchored tanker count, gulf total
   DWT proxy).
2. **Live-ish vessel map** — every 2 min the Windows server posts the
   latest position per vessel currently in the Persian Gulf bbox plus a
   thinned 24h trail per vessel. Map is MapLibre GL with free
   OpenStreetMap raster tiles. Vessel dots colored by size class
   (VLCC/Suezmax/Aframax/small), terminals pinned, click-to-detail.

No backtest UI in v1 (deliberately deferred — the CLI `sea_tracker
backtest` stays local-only for now).

## Architecture

```
Windows server (24/7, accessed via SSH from mac)        Render
─────────────────────────────────────                   ──────────────────────
sea_tracker collect (NSSM service) ──┐                  gcig-api (Express)
  └─→ DuckDB on disk                 │                   ├─ POST /api/sea/signals  (HMAC)
                                     │                   ├─ POST /api/sea/snapshot (HMAC)
enrich + signals + publish-signals   │  HTTPS            ├─ GET  /api/sea/latest   (JWT)
  (Task Scheduler — daily 04:30 ET)──┼─signed───────────►├─ GET  /api/sea/history  (JWT)
                                     │                   └─ Postgres
publish-snapshot                     │                       ├─ SeaSignal (history)
  (Task Scheduler — every 2 min)─────┘                       └─ SeaSnapshot (singleton)

                                                        gcig-client (React)
                                                         └─ /tankers page (JWT)
```

Three concurrent processes on the Windows server:

- **collect** — long-running websocket consumer to AISStream, writes raw
  AIS messages to DuckDB. Already implemented in `sea_tracker/cli.py`.
  Runs as a Windows service via NSSM (auto-restart, survives reboots,
  logs to disk).
- **daily batch** — Task Scheduler at 04:30 ET runs `enrich` →
  `signals --days 14` → `publish-signals --days 90`. Reads from the
  same DuckDB the collector is writing.
- **2-min snapshot** — Task Scheduler runs `publish-snapshot` every 2
  min. Builds the latest-position-per-vessel + thinned-trail payload,
  folds in the latest signal values, posts to Render.

Three processes share the DuckDB file via DuckDB's standard
single-writer / many-readers pattern. The collector is the only writer.

Code distribution: same git repo. After `git push` from the mac,
`git pull` on the Windows server. `sea_tracker/README.md` will document
the install + service-setup steps.

Why CPI-clone rather than alternatives:

- **Single combined ingest endpoint** — rejected, would couple a 2-min
  cadence to daily signal recompute. Failure modes tangle, wastes
  bandwidth.
- **Compute signals on Render** — rejected, would require porting all
  of `signals.py`'s DuckDB SQL (with custom geometry helpers) to
  Postgres. Major scope creep, defeats "Render is a dumb pipe".

## Render-side: Prisma schema

Two tables in `server/prisma/schema.prisma`:

```prisma
// One row per (date, signalName). Mirrors DuckDB's signals_daily on
// the Windows box, but only the latest publish wins on conflict.
// Lets the React panel draw sparklines from history.
model SeaSignal {
  date       DateTime  @db.Date
  signalName String
  value      Float?
  updatedAt  DateTime  @updatedAt

  @@id([date, signalName])
  @@index([signalName, date])
}

// Singleton row keyed on a fixed id. publish-snapshot upserts the
// rolling-latest payload here every 2 min. Storing the whole shape
// as JSONB keeps the schema flexible — we can add fields without
// migrations as the map UI evolves.
model SeaSnapshot {
  id          Int       @id @default(1)
  snapshotAt  DateTime
  vesselCount Int
  payload     Json
  updatedAt   DateTime  @updatedAt
}
```

`SeaSnapshot.payload` JSONB shape:

```json
{
  "bbox": [23.5, 30.5, 47.5, 57.5],
  "vessels": [
    {
      "mmsi": 123456789,
      "name": "VESSEL X",
      "shipType": 80,
      "sizeClass": "vlcc",
      "laden": true,
      "lat": 26.31, "lon": 52.04,
      "sog": 12.4, "cog": 87.0, "heading": 88,
      "lastSeen": "2026-05-04T20:38:42Z",
      "trail": [[26.10, 51.80, "2026-05-03T20:30:00Z"], ...]
    }
  ],
  "terminals": [
    { "name": "ras_tanura", "country": "saudi",
      "lat": 26.65, "lon": 50.17, "radiusKm": 8.0 }
  ],
  "signals": {
    "hormuz_outbound_laden_count": { "value": 14, "asOf": "2026-05-03" },
    "anchored_tanker_count":       { "value":  9, "asOf": "2026-05-03" }
  }
}
```

Trails are pre-thinned by the Python publisher (Douglas-Peucker @ ~50m
tolerance, capped at 200 points/vessel over 24h). Worst-case payload:
500 vessels × 200 points × ~25 bytes ≈ 2.5 MB; typical ~500 KB. Express
JSON limit will be raised to 25 MB if not already there.

Signals are folded into the snapshot payload so the page needs one read
on load. The `SeaSignal` history table is only consulted for sparkline
expansions on `/api/sea/history`.

Singleton vs append-only snapshot history: singleton for v1. A
`SeaSnapshotLog` table can be added later if a time-replay slider is
wanted.

## Render-side: API routes

New file `server/src/routes/sea.js`, mounted at `/api/sea` in
`server/src/index.js`. Mirrors `cpi.js`.

**HMAC scheme:** identical to CPI but with separate secret
`SEA_INGEST_SECRET` and headers `X-Sea-Timestamp` / `X-Sea-Signature`.
Path-bound signature, 5-minute timestamp tolerance. Separate secret so
a leaked CPI token can't be replayed against `/api/sea/*`.

Off-platform (HMAC):

```
POST /api/sea/signals
  Body: { signals: [{ date: "YYYY-MM-DD", name, value }, ...] }
  Upserts each row into SeaSignal. Idempotent.

POST /api/sea/snapshot
  Body: { snapshotAt: ISO, vesselCount: int, payload: {...} }
  Upserts SeaSnapshot id=1.
```

In-app (JWT, after `router.use(verifyJwt)`):

```
GET /api/sea/latest
  Returns: { configured: bool, snapshot: { snapshotAt, vesselCount, ...payload } | null }
  Single fetch the /tankers page hits on load + every 30s.

GET /api/sea/history?signal=<name>&days=<n>
  Returns: { points: [{ date, value }, ...] }
  For sparklines. days defaults to 90, capped at 365.
```

Failure modes:

- Snapshot publish blip → publisher retries on next 2-min tick. Map
  shows stale `snapshotAt` until next success.
- Daily signals blip → cron retries next day. Panel shows yesterday's
  values; `asOf` makes staleness obvious.
- Render cold start (free tier, ~30–60s wake) → 60s timeout in the
  Python client absorbs it. The 2-min cadence keeps the service warm
  in steady state.
- Postgres drop → Prisma retries; surfaces as 503; treated as blip.

## Windows-side: Python publisher modules

New files in `sea_tracker/`:

- **`api_client.py`** — HMAC-signed client. Functions:
  - `post_signals(rows: list[dict]) -> dict`
  - `post_snapshot(payload: dict) -> dict`
  - Reads env vars `GCIG_API_URL`, `SEA_INGEST_SECRET`.
  - 60s timeout (matches CPI; absorbs Render cold-start).

- **`publish.py`** — thin wrapper around `api_client`, kept separate to
  keep `cli.py` imports readable (matches CPI structure).

- **`snapshot.py`** — builds the snapshot payload from DuckDB:
  - Latest position per vessel in `vessels` whose most recent
    `ais_messages.ts` is within the last 30 min and inside `bbox`.
  - 24h trail per vessel from `ais_messages`, thinned via Douglas-
    Peucker (small hand-rolled implementation; avoid adding the `rdp`
    dep — it pulls in numpy ABI risk on Windows). Cap 200 points.
  - Latest value per signal from `signals_daily` (most recent day with
    a value).
  - Terminal list from `geo.TERMINALS` (constant; mostly there for the
    React map's convenience).

New CLI commands in `sea_tracker/cli.py`:

```python
@app.command("publish-signals")
def publish_signals(
    days: int = typer.Option(90, "--days", "-d"),
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
):
    """Read last N days from signals_daily and POST to gcig-api."""

@app.command("publish-snapshot")
def publish_snapshot(
    config: Path = typer.Option(Path("config.toml"), "--config", "-c"),
):
    """Build snapshot payload from DuckDB and POST to gcig-api."""
```

Both commands open a read-only DuckDB connection so they can run
alongside the writer (`collect`).

## Client-side: React page

New page `client/src/pages/Tankers.jsx`. Routed at `/tankers`. Sidebar
entry "Tanker Tracker" added under the Macro group, next to "CPI
Forecast".

Layout (top to bottom):

- **Header strip** — title, last-updated relative time, manual refresh
  button. Polls `/api/sea/latest` every 30s.
- **Signal panel** — grid of cards (responsive: 4 wide on desktop,
  2 wide on tablet, 1 wide on phone). Each card shows: signal name,
  current value with sensible formatting (counts as integers, ratios as
  percentages, DWT proxies as compact numbers like "528K"), 90-day
  sparkline (recharts, lazy-fetched from `/api/sea/history` when the
  card scrolls into view), and "as of YYYY-MM-DD" footer.
- **Live map** — full-width, ~600px tall. MapLibre GL JS with
  OpenStreetMap raster tiles (no key, no auth). Default view: bbox
  centered. Vessel dots colored by size class with the project navy/gold
  palette extended (VLCC = brand gold, Suezmax = navy, Aframax = slate,
  small = gray). Trails as faint polylines. Terminal pins as small
  diamond markers labeled with the terminal name.
- **Vessel detail drawer** — slides in from the right when a dot is
  clicked. Shows MMSI, name, ship type, size class, laden flag,
  current sog/cog/heading, last seen, and a "View on MarineTraffic"
  external link (`https://www.marinetraffic.com/en/ais/details/ships/mmsi:<MMSI>`).

New client deps: `maplibre-gl` (free, ~700 KB gzipped). `recharts` is
already in the bundle for sparklines.

Auth and visibility: same as `/cpi` — any logged-in member can see it.
No role gating in v1.

## Local config and scheduling

On the Windows server:

- `C:\sea_tracker\config.toml` (gitignored) — aisstream key, bbox,
  storage paths.
- `C:\sea_tracker\.env` (gitignored) — `GCIG_API_URL`,
  `SEA_INGEST_SECRET`.
- `sea_tracker/config.example.toml` checked in alongside the package
  with placeholder values and inline comments.

NSSM service config (one-time setup, documented in
`sea_tracker/README.md`):

```
nssm install sea_tracker_collect "C:\Python311\python.exe"
nssm set     sea_tracker_collect AppParameters "-m sea_tracker.cli collect --config C:\sea_tracker\config.toml"
nssm set     sea_tracker_collect AppDirectory "C:\sea_tracker"
nssm set     sea_tracker_collect AppStdout "C:\sea_tracker\logs\collect.log"
nssm set     sea_tracker_collect AppStderr "C:\sea_tracker\logs\collect.err"
nssm set     sea_tracker_collect AppRestartDelay 5000
```

Task Scheduler tasks (one-time setup, documented in README):

- **Daily 04:30 ET (09:30 UTC):** wrapper batch script that runs
  `enrich → signals --days 14 → publish-signals --days 90` in sequence.
  Skips on collector-down (sees stale data), logs to file.
- **Every 2 min:** `publish-snapshot --config C:\sea_tracker\config.toml`.
  Runs as the same user as the collector. Logs append-only.

On Render:

- New env var `SEA_INGEST_SECRET` (same hex as the Windows .env). Set
  via Render dashboard, not committed.
- New Prisma migration for `SeaSignal` + `SeaSnapshot`. Auto-runs on
  deploy via existing build command (`npx prisma migrate deploy`).
- New router mount in `server/src/index.js`.
- `express.json` body limit raised to 25 MB if not already.

## Out of scope (v1)

Explicit non-goals so they don't sneak into the implementation plan:

- Backtest UI page. Local-only via existing CLI for now.
- `SeaSnapshotLog` time-replay table.
- Push notifications on signal anomalies.
- Vessel-name → ticker correlation (e.g. "this VLCC is in the Saudi
  Aramco fleet"). Cool but a research project of its own.
- Per-role visibility gating (defer until / unless asked).
- Live websocket from Windows → Render → React.
- Hosting our own map tiles. Stay on free OpenStreetMap until traffic
  forces a change.

## Success criteria

- A logged-in member can open `/tankers` and see vessel positions in
  the Persian Gulf updating without page reload, plus the seven signal
  values with sparklines.
- The Windows server publishes snapshots reliably for 24h with no
  manual intervention; daily-cron signals publish post-04:30 ET.
- No external API key (AISStream, FRED, …) appears in any committed
  file. All secrets live on Render or the Windows server.
- Failure of any single piece (collector down, snapshot blip, Render
  cold start) degrades visibly but doesn't crash the page.
