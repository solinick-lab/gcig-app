# sea_tracker — Persian Gulf tanker AIS pipeline

Off-platform Python collector + signal publisher that runs on the
Windows server and feeds gcig-api at `/api/sea/*`. The AISStream API
key, DuckDB store, and AIS websocket consumer all live here. Render
gets only HMAC-signed signal rows and snapshot payloads.

## Architecture

See `docs/superpowers/specs/2026-05-04-sea-tracker-design.md` for the
authoritative picture. Short version: `collect` runs forever (NSSM
service), `enrich + signals + publish-signals` runs once a day (Task
Scheduler), `publish-snapshot` runs every two minutes (Task
Scheduler).

## First-time install (Windows server, PowerShell as admin)

1. Install Python 3.11+ from python.org. Tick "Add Python to PATH".

2. Install [NSSM](https://nssm.cc/download) — extract `nssm.exe` to
   `C:\Tools\nssm\nssm.exe` and add that folder to PATH.

3. Clone the repo and create a venv:

   ```powershell
   cd C:\
   git clone https://github.com/newtheyork-pixel/gcig-app.git
   cd C:\gcig-app
   python -m venv .venv
   .venv\Scripts\Activate.ps1
   pip install -e ".\sea_tracker[dev]"
   ```

4. Make the runtime layout outside the repo so config + data are not
   wiped by `git pull`:

   ```powershell
   New-Item -ItemType Directory -Force C:\sea_tracker\data
   New-Item -ItemType Directory -Force C:\sea_tracker\logs
   Copy-Item .\sea_tracker\config.example.toml C:\sea_tracker\config.toml
   notepad C:\sea_tracker\config.toml
   ```

   Leave `aisstream.api_key` as the placeholder — the collector pulls
   the real key from Render at startup. Save.

5. Drop a `.env` next to the config:

   ```powershell
   notepad C:\sea_tracker\.env
   ```

   Contents:

   ```
   GCIG_API_URL=https://gcig-api.onrender.com
   SEA_INGEST_SECRET=<the same hex you set on Render>
   ```

   Save.

## Render env vars (set both)

In the Render dashboard for the gcig-api service, add two environment
variables:

- `SEA_INGEST_SECRET` — shared HMAC secret. Generate once on the mac:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  Same hex goes into `C:\sea_tracker\.env` on the Windows box. If they
  don't match byte-for-byte, every Render call from the box returns
  401.

- `AISSTREAM_API_KEY` — the real AISStream key. Lives ONLY on Render.
  The collector fetches it via HMAC-authed `GET /api/sea/secrets` at
  startup.

## Install the collector as a Windows service (NSSM)

```powershell
$py = "C:\gcig-app\.venv\Scripts\python.exe"
$args = "-m sea_tracker.cli collect --config C:\sea_tracker\config.toml"

nssm install sea_tracker_collect $py
nssm set sea_tracker_collect AppParameters $args
nssm set sea_tracker_collect AppDirectory C:\gcig-app
nssm set sea_tracker_collect AppEnvironmentExtra `
    "GCIG_API_URL=https://gcig-api.onrender.com" `
    "SEA_INGEST_SECRET=<the hex>"
nssm set sea_tracker_collect AppStdout C:\sea_tracker\logs\collect.log
nssm set sea_tracker_collect AppStderr C:\sea_tracker\logs\collect.err
nssm set sea_tracker_collect AppRotateFiles 1
nssm set sea_tracker_collect AppRotateBytes 10485760
nssm set sea_tracker_collect AppRestartDelay 5000
nssm start sea_tracker_collect
```

Verify with `nssm status sea_tracker_collect` and tail
`C:\sea_tracker\logs\collect.log`.

## Schedule the daily and 2-min publishers (Task Scheduler)

Create two scheduled tasks. Use the Task Scheduler GUI or the
following XML imports.

### Daily 04:30 ET (09:30 UTC) — full batch

Action: Start a program

```
Program/script:  C:\gcig-app\.venv\Scripts\python.exe
Arguments:       -m sea_tracker.cli enrich -c C:\sea_tracker\config.toml
Start in:        C:\gcig-app
```

Add two more "Start a program" actions in the same task, in order:

```
-m sea_tracker.cli signals -d 14 -c C:\sea_tracker\config.toml
-m sea_tracker.cli publish-signals -d 90 -c C:\sea_tracker\config.toml
```

Trigger: Daily, 04:30 server local time. (Windows runs in your
server's local TZ. If the server is in UTC, set 09:30 instead.)

In the task's Settings tab tick "Run task as soon as possible after a
scheduled start is missed" so a reboot doesn't skip a day.

### Every 2 minutes — snapshot

Action: Start a program

```
Program/script:  C:\gcig-app\.venv\Scripts\python.exe
Arguments:       -m sea_tracker.cli publish-snapshot -c C:\sea_tracker\config.toml
Start in:        C:\gcig-app
```

Trigger: One time at task creation, then "Repeat task every 2 minutes
for indefinite duration". Settings tab: tick "Stop the task if it
runs longer than 2 minutes" to avoid pile-ups, and "If the task is
already running, do not start a new instance".

## Updating the code

```powershell
cd C:\gcig-app
git pull
.venv\Scripts\Activate.ps1
pip install -e ".\sea_tracker"
nssm restart sea_tracker_collect
```

## Tail-the-logs cheatsheet

```powershell
Get-Content -Wait C:\sea_tracker\logs\collect.log
Get-Content -Wait C:\sea_tracker\logs\publish.log
```

## Known quirks

- DuckDB allows many readers + one writer. The collector is the only
  writer; `publish-snapshot` and `publish-signals` open read-only
  connections, but we still pass the same path — DuckDB serializes
  internally so this works.
- `yfinance` occasionally rate-limits; the daily `prices` command
  retries on 429. If it falls through, signals still publish; backtest
  reports just lag a day.
- AISStream rotates their websocket endpoint occasionally; if collect
  starts logging connection errors for hours, check
  https://aisstream.io status and re-deploy.
