# Tanker Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing `sea_tracker/` Python pipeline at `/tankers` in the React client — signal panel + live vessel map — while keeping all collector code, the AISStream API key, and DuckDB on Thomas's Windows server. Render's gcig-api stays a dumb HMAC-authed pipe, identical pattern to the CPI forecaster.

**Architecture:** Three concurrent processes on the Windows server (NSSM-supervised collector + Task-Scheduler daily batch + Task-Scheduler 2-min snapshot publisher) push HMAC-signed payloads to two new endpoints on `gcig-api`. The API persists into Postgres (`SeaSignal` history table + `SeaSnapshot` singleton row) and serves a JWT-authed read API to the React client, which renders a MapLibre map plus recharts sparklines.

**Tech Stack:**
- Python 3.11+: typer, duckdb, websockets (existing), `requests` (new), `pytest` (new)
- Node/Express + Prisma 5 (existing)
- React 18 + Vite + Tailwind (existing) + `maplibre-gl` (new)
- Postgres on Render (existing)
- Windows runtime: NSSM + Task Scheduler

---

## File Map

**Server (Render):**
- Modify: `server/prisma/schema.prisma` — add `SeaSignal`, `SeaSnapshot` models
- Create: `server/prisma/migrations/<timestamp>_add_sea_tracker/migration.sql`
- Create: `server/src/routes/sea.js` — HMAC ingest + JWT reads
- Modify: `server/src/index.js` — mount router, raise `express.json` limit to `25mb`

**Python (sea_tracker/):**
- Create: `sea_tracker/api_client.py` — HMAC client for gcig-api
- Create: `sea_tracker/publish.py` — thin wrapper used by CLI
- Create: `sea_tracker/snapshot.py` — builds the snapshot payload from DuckDB
- Create: `sea_tracker/rdp.py` — small Douglas-Peucker implementation
- Modify: `sea_tracker/cli.py` — add `publish-signals` and `publish-snapshot` commands
- Create: `sea_tracker/config.example.toml` — sample config with placeholders
- Create: `sea_tracker/pyproject.toml` — project metadata + deps
- Create: `sea_tracker/tests/__init__.py`
- Create: `sea_tracker/tests/test_rdp.py`
- Create: `sea_tracker/tests/test_api_client.py`
- Create: `sea_tracker/tests/test_snapshot.py`
- Create: `sea_tracker/README.md` — Windows install + service setup

**Client (gcig-client):**
- Modify: `client/package.json` — add `maplibre-gl`
- Create: `client/src/api/sea.js` — axios wrapper
- Create: `client/src/pages/Tankers.jsx` — page shell + data plumbing
- Create: `client/src/pages/tankers/SignalPanel.jsx` — grid of signal cards
- Create: `client/src/pages/tankers/SignalCard.jsx` — single card with sparkline
- Create: `client/src/pages/tankers/VesselMap.jsx` — MapLibre map
- Create: `client/src/pages/tankers/VesselDrawer.jsx` — vessel detail side panel
- Modify: `client/src/App.jsx` — add `/tankers` route
- Modify: `client/src/components/Sidebar.jsx` — add "Tanker Tracker" entry

**Repo root:**
- Modify: `.gitignore` — ignore sea_tracker config & data

---

## Test Strategy

The existing JS codebase has no test framework. Don't bolt one on for this plan. Instead:

- **Server**: integration smoke tests via curl in the task steps (HMAC sign + POST + GET); the route handler is small and the contract is verified end-to-end against a live local Postgres.
- **Python**: real pytest, for `rdp`, `api_client` (mocked HTTP), and `snapshot` (mocked DuckDB connection). The Python side is where the only nontrivial logic lives.
- **Client**: manual smoke test in the dev server. The page is mostly glue around hooks + a map library; e2e infrastructure isn't worth standing up for this plan.

---

## Task 1: Add Prisma models for SeaSignal + SeaSnapshot

**Files:**
- Modify: `server/prisma/schema.prisma`

- [ ] **Step 1: Append the two models to the schema**

Open `server/prisma/schema.prisma`. Find the existing `CpiForecast` model. Append these two models below it:

```prisma
// One row per (date, signalName). Mirrors DuckDB's signals_daily on
// the Windows server, with the latest publish winning on conflict.
// History feeds the sparklines on the /tankers panel.
model SeaSignal {
  date       DateTime @db.Date
  signalName String
  value      Float?
  updatedAt  DateTime @updatedAt

  @@id([date, signalName])
  @@index([signalName, date])
}

// Singleton row keyed on a fixed id. publish-snapshot upserts the
// rolling-latest payload here every two minutes. Storing the whole
// shape as Json keeps the schema flexible: we can add fields without
// migrations as the map UI evolves.
model SeaSnapshot {
  id          Int      @id @default(1)
  snapshotAt  DateTime
  vesselCount Int
  payload     Json
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: Generate the migration**

Run from `server/`:

```bash
cd server && npx prisma migrate dev --name add_sea_tracker
```

Expected: Prisma creates `server/prisma/migrations/<timestamp>_add_sea_tracker/migration.sql` and applies it to the local dev DB. Output ends with "Your database is now in sync with your schema."

- [ ] **Step 3: Verify the migration SQL looks right**

Read the new `migration.sql`. It should contain `CREATE TABLE "SeaSignal"` and `CREATE TABLE "SeaSnapshot"`, plus the index. No drops or unrelated changes.

- [ ] **Step 4: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "$(cat <<'EOF'
db: add SeaSignal and SeaSnapshot models

Daily signal history for sparklines; singleton snapshot row that the
2-min publish-snapshot job upserts. JSONB payload keeps the shape
flexible while the map UI lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add HMAC ingest + JWT read routes

**Files:**
- Create: `server/src/routes/sea.js`
- Modify: `server/src/index.js`

- [ ] **Step 1: Create `server/src/routes/sea.js`**

```javascript
// Tanker Tracker routes.
//
// HMAC-authed (called from the Windows-side sea_tracker publisher):
//   POST /api/sea/signals    Bulk-upsert SeaSignal rows.
//   POST /api/sea/snapshot   Upsert the singleton SeaSnapshot row.
//
// JWT-authed (called by the React app):
//   GET  /api/sea/latest     The current snapshot payload + meta.
//   GET  /api/sea/history    Per-signal day-by-day series for sparklines.
//
// HMAC scheme matches sea_tracker/api_client.py:
//   message = `${timestamp}.${path}.${rawBody}`
//   signature = hex( HMAC_SHA256(SEA_INGEST_SECRET, message) )
//   X-Sea-Timestamp: <unix seconds>
//   X-Sea-Signature: <hex digest>
//
// Path is bound into the signature so a captured /signals signature
// cannot be replayed against /snapshot inside the 5-min tolerance.

import { Router } from 'express';
import crypto from 'node:crypto';
import prisma from '../db.js';
import { verifyJwt } from '../middleware/auth.js';

const router = Router();

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

function verifyHmac(pathForSig) {
  return (req, res, next) => {
    const secret = process.env.SEA_INGEST_SECRET;
    if (!secret) return res.status(503).json({ error: 'Sea ingest not configured' });

    const tsHeader = req.headers['x-sea-timestamp'];
    const sigHeader = req.headers['x-sea-signature'];
    if (!tsHeader || !sigHeader) {
      return res.status(401).json({ error: 'Missing signature headers' });
    }
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) {
      return res.status(401).json({ error: 'Invalid timestamp' });
    }
    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > TIMESTAMP_TOLERANCE_SECONDS) {
      return res.status(401).json({ error: 'Timestamp outside tolerance window' });
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${tsHeader}.${pathForSig}.`)
      .update(req.rawBody || Buffer.alloc(0))
      .digest('hex');
    let sigOk = false;
    try {
      sigOk = crypto.timingSafeEqual(
        Buffer.from(expected, 'hex'),
        Buffer.from(String(sigHeader), 'hex')
      );
    } catch {
      sigOk = false;
    }
    if (!sigOk) return res.status(401).json({ error: 'Invalid signature' });
    next();
  };
}

// ── Off-platform: bulk signal upsert ─────────────────────────────────
router.post(
  '/signals',
  verifyHmac('/api/sea/signals'),
  async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.signals)) {
      return res.status(400).json({ error: 'signals[] missing' });
    }
    let written = 0;
    for (const row of body.signals) {
      if (!row || typeof row !== 'object') continue;
      const { date, name, value } = row;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
      if (typeof name !== 'string' || !name) continue;
      const numeric = value === null || value === undefined ? null : Number(value);
      if (numeric !== null && !Number.isFinite(numeric)) continue;
      await prisma.seaSignal.upsert({
        where: { date_signalName: { date: new Date(date), signalName: name } },
        update: { value: numeric },
        create: { date: new Date(date), signalName: name, value: numeric },
      });
      written += 1;
    }
    return res.json({ ok: true, written });
  }
);

// ── Off-platform: snapshot upsert ────────────────────────────────────
router.post(
  '/snapshot',
  verifyHmac('/api/sea/snapshot'),
  async (req, res) => {
    const body = req.body || {};
    const { snapshotAt, vesselCount, payload } = body;
    if (!snapshotAt) {
      return res.status(400).json({ error: 'snapshotAt missing' });
    }
    const at = new Date(snapshotAt);
    if (Number.isNaN(at.getTime())) {
      return res.status(400).json({ error: 'snapshotAt must be ISO 8601' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'payload object missing' });
    }
    const count = Number.isFinite(Number(vesselCount)) ? Number(vesselCount) : 0;
    const row = await prisma.seaSnapshot.upsert({
      where: { id: 1 },
      update: { snapshotAt: at, vesselCount: count, payload },
      create: { id: 1, snapshotAt: at, vesselCount: count, payload },
    });
    return res.json({ ok: true, snapshotAt: row.snapshotAt });
  }
);

// ── In-app reads (members only) ──────────────────────────────────────
router.use(verifyJwt);

router.get('/latest', async (_req, res) => {
  const row = await prisma.seaSnapshot.findUnique({ where: { id: 1 } });
  if (!row) {
    return res.json({ configured: false, snapshot: null });
  }
  return res.json({
    configured: true,
    snapshot: {
      snapshotAt: row.snapshotAt,
      vesselCount: row.vesselCount,
      ...row.payload,
    },
  });
});

router.get('/history', async (req, res) => {
  const signal = String(req.query.signal || '').trim();
  if (!signal) return res.status(400).json({ error: 'signal query param required' });
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await prisma.seaSignal.findMany({
    where: { signalName: signal, date: { gte: since } },
    orderBy: { date: 'asc' },
  });
  return res.json({
    points: rows.map((r) => ({
      date: r.date.toISOString().slice(0, 10),
      value: r.value,
    })),
  });
});

export default router;
```

- [ ] **Step 2: Mount the router and raise the body limit in `server/src/index.js`**

Find the existing block that mounts `cpiRoutes`. Add `seaRoutes` import next to it and mount it. Find `express.json({ limit: '2mb', ... })` and bump to `25mb`.

Apply these edits:

1. Add the import alongside other route imports near the top of `server/src/index.js`:

```javascript
import seaRoutes from './routes/sea.js';
```

2. Bump the JSON body limit. Replace:

```javascript
  express.json({
    limit: '2mb',
```

with:

```javascript
  express.json({
    limit: '25mb',
```

3. Mount the router. Find the existing `app.use('/api/cpi', cpiRoutes);` line (or wherever cpi is mounted) and add directly below it:

```javascript
app.use('/api/sea', seaRoutes);
```

- [ ] **Step 3: Set the local secret and start the server**

```bash
cd server
echo "SEA_INGEST_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
npm run dev
```

Server should start on `:4000` with no errors.

- [ ] **Step 4: Smoke-test the HMAC endpoint with curl**

In a second terminal:

```bash
SECRET=$(grep '^SEA_INGEST_SECRET=' server/.env | cut -d= -f2)
TS=$(date +%s)
PATH_SIG="/api/sea/signals"
BODY='{"signals":[{"date":"2026-05-03","name":"hormuz_outbound_laden_count","value":14}]}'
SIG=$(printf '%s.%s.%s' "$TS" "$PATH_SIG" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -X POST http://localhost:4000/api/sea/signals \
  -H "Content-Type: application/json" \
  -H "X-Sea-Timestamp: $TS" \
  -H "X-Sea-Signature: $SIG" \
  -d "$BODY"
```

Expected: `{"ok":true,"written":1}`

- [ ] **Step 5: Test the JWT read returns 401 without a token**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/sea/latest
```

Expected: `401`

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/sea.js server/src/index.js
git commit -m "$(cat <<'EOF'
api: HMAC ingest and JWT reads for tanker tracker

POST /api/sea/signals and /api/sea/snapshot accept HMAC-signed bulk
writes from the Windows-side sea_tracker. GET /api/sea/latest and
/history are JWT-authed for the React page. Path-bound signatures
prevent cross-endpoint replay; body limit raised to 25mb to fit a
worst-case full-bbox snapshot with 24h trails.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Python project metadata, dev deps, and example config

**Files:**
- Create: `sea_tracker/pyproject.toml`
- Create: `sea_tracker/config.example.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Create `sea_tracker/pyproject.toml`**

```toml
[project]
name = "sea_tracker"
version = "0.1.0"
description = "Persian Gulf tanker AIS pipeline + signal publisher for gcig-app."
requires-python = ">=3.11"
dependencies = [
    "duckdb>=1.0.0",
    "typer>=0.12",
    "rich>=13.0",
    "websockets>=12.0",
    "pyyaml>=6.0",
    "yfinance>=0.2.40",
    "pandas>=2.2",
    "requests>=2.32",
]

[project.optional-dependencies]
dev = ["pytest>=8.0", "pytest-mock>=3.12"]

[project.scripts]
sea_tracker = "sea_tracker.cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["."]
```

- [ ] **Step 2: Create `sea_tracker/config.example.toml`**

```toml
# Copy this file to `config.toml` next to the sea_tracker package on the
# Windows server and fill in the placeholders. Do NOT commit config.toml.

[aisstream]
api_key = "REPLACE_ME_AISSTREAM_KEY"

# Persian Gulf bbox. Edit only if you know what you are doing —
# signals.py constants assume these bounds.
[bbox]
lat_min = 23.5
lat_max = 30.5
lon_min = 47.5
lon_max = 57.5

# Windows-style paths. Use forward slashes; pathlib handles them.
[storage]
db_path     = "C:/sea_tracker/data/sea.duckdb"
parquet_dir = "C:/sea_tracker/data/parquet"
log_dir     = "C:/sea_tracker/logs"
```

- [ ] **Step 3: Update `.gitignore`**

Append to the project root `.gitignore`:

```
# sea_tracker — local secrets and data must never be committed
sea_tracker/config.toml
sea_tracker/.env
sea_tracker/data/
sea_tracker/logs/
sea_tracker/__pycache__/
sea_tracker/.venv/
sea_tracker/*.egg-info/
```

- [ ] **Step 4: Commit**

```bash
git add sea_tracker/pyproject.toml sea_tracker/config.example.toml .gitignore
git commit -m "$(cat <<'EOF'
sea_tracker: pyproject, example config, gitignore

Locks Python dependency floors, declares the typer entry point as
`sea_tracker`, and ships a config.example.toml so the Windows install
flow is just copy-rename-edit. Real config.toml stays gitignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Douglas-Peucker trail thinner with tests

**Files:**
- Create: `sea_tracker/rdp.py`
- Create: `sea_tracker/tests/__init__.py`
- Create: `sea_tracker/tests/test_rdp.py`

- [ ] **Step 1: Create `sea_tracker/tests/__init__.py`**

Empty file. Just:

```python
```

- [ ] **Step 2: Write the failing test**

Create `sea_tracker/tests/test_rdp.py`:

```python
from datetime import datetime, timedelta

from sea_tracker.rdp import thin_trail


def _pt(lat, lon, t):
    return (lat, lon, t)


def test_empty_input_returns_empty():
    assert thin_trail([], tolerance_deg=0.001, max_points=200) == []


def test_two_points_unchanged():
    a = _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0))
    b = _pt(26.1, 52.1, datetime(2026, 5, 4, 10, 30))
    out = thin_trail([a, b], tolerance_deg=0.001, max_points=200)
    assert out == [a, b]


def test_collinear_points_collapse_to_endpoints():
    # Three collinear points in lat-lon space; the middle one should drop.
    pts = [
        _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0)),
        _pt(26.5, 52.5, datetime(2026, 5, 4, 10, 30)),
        _pt(27.0, 53.0, datetime(2026, 5, 4, 11, 0)),
    ]
    out = thin_trail(pts, tolerance_deg=0.01, max_points=200)
    assert out == [pts[0], pts[2]]


def test_zigzag_keeps_inflection_points():
    # A clear zigzag: any reasonable RDP must keep at least 3 points.
    pts = [
        _pt(26.0, 52.0, datetime(2026, 5, 4, 10, 0)),
        _pt(26.5, 52.5, datetime(2026, 5, 4, 10, 10)),
        _pt(26.0, 53.0, datetime(2026, 5, 4, 10, 20)),
        _pt(26.5, 53.5, datetime(2026, 5, 4, 10, 30)),
    ]
    out = thin_trail(pts, tolerance_deg=0.001, max_points=200)
    assert len(out) >= 3
    assert out[0] == pts[0]
    assert out[-1] == pts[-1]


def test_max_points_cap_is_enforced():
    # 500 noisy points; cap should clamp output length.
    base = datetime(2026, 5, 4, 10, 0)
    pts = []
    for i in range(500):
        lat = 26.0 + 0.001 * (i % 7)
        lon = 52.0 + 0.001 * i
        pts.append(_pt(lat, lon, base + timedelta(seconds=i)))
    out = thin_trail(pts, tolerance_deg=1e-9, max_points=50)
    assert len(out) <= 50
    assert out[0] == pts[0]
    assert out[-1] == pts[-1]
```

- [ ] **Step 3: Run test — expect failure**

```bash
cd sea_tracker && python -m pytest tests/test_rdp.py -v
```

Expected: ImportError because `sea_tracker.rdp` does not exist yet, OR collection error.

- [ ] **Step 4: Implement `sea_tracker/rdp.py`**

```python
"""Douglas-Peucker line simplification for vessel trails.

Operates in raw (lat, lon) degree space. Tolerance is interpreted as
perpendicular degree distance, which is good enough for thinning a
coastal trail to a few dozen visually-faithful points. Each input
point is a tuple of (lat, lon, anything-else); only lat/lon participate
in the geometry test.

Why hand-rolled instead of `rdp` from PyPI: that package depends on
numpy, and on Windows the AISStream collector has had numpy ABI
flake-out before. The trails are tiny — a from-scratch implementation
is ~30 lines and avoids the binary dep.
"""

from __future__ import annotations

from typing import Sequence


def _perp_distance(p, a, b) -> float:
    # Perpendicular distance from point p to segment a-b in lat/lon space.
    px, py = p[1], p[0]
    ax, ay = a[1], a[0]
    bx, by = b[1], b[0]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        # a and b coincide — distance reduces to point-to-point.
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    # Numerator is twice the signed area of the triangle a-b-p.
    num = abs(dy * px - dx * py + bx * ay - by * ax)
    return num / ((dx * dx + dy * dy) ** 0.5)


def _douglas_peucker(points: Sequence, tol: float) -> list:
    if len(points) < 3:
        return list(points)
    # Find the point farthest from the chord between the endpoints.
    a, b = points[0], points[-1]
    max_d = -1.0
    max_i = -1
    for i in range(1, len(points) - 1):
        d = _perp_distance(points[i], a, b)
        if d > max_d:
            max_d = d
            max_i = i
    if max_d <= tol or max_i < 0:
        return [a, b]
    # Recurse on both halves; drop the duplicated split point on join.
    left = _douglas_peucker(points[: max_i + 1], tol)
    right = _douglas_peucker(points[max_i:], tol)
    return left[:-1] + right


def thin_trail(points: Sequence, *, tolerance_deg: float, max_points: int) -> list:
    """Return a thinned copy of `points`.

    `points` is an ordered sequence of (lat, lon, *rest) tuples. The
    thinned result preserves order and always keeps the first and last
    points. If RDP alone leaves more than `max_points`, the result is
    further down-sampled by uniform stride.
    """
    if not points:
        return []
    if len(points) <= 2:
        return list(points)
    out = _douglas_peucker(list(points), tolerance_deg)
    if len(out) <= max_points:
        return out
    # Uniformly stride down to max_points. Always keep first and last.
    stride = max(1, (len(out) - 1) // (max_points - 1))
    strided = out[::stride]
    if strided[-1] != out[-1]:
        strided.append(out[-1])
    return strided[:max_points]
```

- [ ] **Step 5: Install the package and run the tests**

From the repo root:

```bash
python3 -m venv sea_tracker/.venv
source sea_tracker/.venv/bin/activate
pip install -e "sea_tracker[dev]"
cd sea_tracker && python -m pytest tests/test_rdp.py -v
```

Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add sea_tracker/rdp.py sea_tracker/tests/__init__.py sea_tracker/tests/test_rdp.py
git commit -m "$(cat <<'EOF'
sea_tracker: Douglas-Peucker trail thinner

Hand-rolled to avoid numpy-on-Windows ABI risk. Operates on
(lat, lon, *rest) tuples; preserves order and endpoints; clamps to a
hard max_points cap via uniform striding when RDP alone is not
aggressive enough. Used by snapshot.py to bound trail payload size.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: HMAC API client for gcig-api

**Files:**
- Create: `sea_tracker/api_client.py`
- Create: `sea_tracker/tests/test_api_client.py`

- [ ] **Step 1: Write the failing test**

Create `sea_tracker/tests/test_api_client.py`:

```python
import hashlib
import hmac
from unittest.mock import MagicMock, patch

import pytest

from sea_tracker import api_client


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("GCIG_API_URL", "https://api.example.com")
    monkeypatch.setenv("SEA_INGEST_SECRET", "test-secret")


def _expected_sig(ts: str, path: str, body: bytes) -> str:
    msg = f"{ts}.{path}.".encode("ascii") + body
    return hmac.new(b"test-secret", msg, hashlib.sha256).hexdigest()


def test_post_signals_signs_correctly():
    rows = [{"date": "2026-05-03", "name": "x", "value": 1.0}]
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": True, "written": 1}
        req.post.return_value = resp
        out = api_client.post_signals(rows)

    assert out == {"ok": True, "written": 1}
    args, kwargs = req.post.call_args
    assert args[0] == "https://api.example.com/api/sea/signals"
    headers = kwargs["headers"]
    assert headers["Content-Type"] == "application/json"
    ts = headers["X-Sea-Timestamp"]
    sig = headers["X-Sea-Signature"]
    body = kwargs["data"]
    assert sig == _expected_sig(ts, "/api/sea/signals", body)


def test_post_snapshot_signs_correctly():
    payload = {"snapshotAt": "2026-05-04T20:00:00Z", "vesselCount": 0, "payload": {}}
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"ok": True}
        req.post.return_value = resp
        api_client.post_snapshot(payload)

    args, kwargs = req.post.call_args
    assert args[0] == "https://api.example.com/api/sea/snapshot"
    body = kwargs["data"]
    headers = kwargs["headers"]
    assert headers["X-Sea-Signature"] == _expected_sig(
        headers["X-Sea-Timestamp"], "/api/sea/snapshot", body
    )


def test_missing_env_raises(monkeypatch):
    monkeypatch.delenv("GCIG_API_URL", raising=False)
    with pytest.raises(RuntimeError, match="GCIG_API_URL"):
        api_client.post_signals([])


def test_4xx_raises():
    with patch.object(api_client, "requests") as req:
        resp = MagicMock(status_code=401, text="nope")
        req.post.return_value = resp
        with pytest.raises(RuntimeError, match="signals POST failed"):
            api_client.post_signals([{"date": "2026-05-03", "name": "x", "value": 1}])
```

- [ ] **Step 2: Run the test — expect ImportError**

```bash
cd sea_tracker && python -m pytest tests/test_api_client.py -v
```

Expected: collection failure or ImportError on `from sea_tracker import api_client`.

- [ ] **Step 3: Implement `sea_tracker/api_client.py`**

```python
"""HMAC-signed client for gcig-api.

Single upstream: the gcig-api Render service. The AISStream key never
leaves this machine — only computed signals and rolling snapshots go
out, both authenticated with HMAC over (timestamp + path + body).

HMAC scheme — must match server/src/routes/sea.js verifyHmac():
    message = f"{timestamp}.{path}.".encode() + raw_body
    signature = hex(HMAC_SHA256(SEA_INGEST_SECRET, message))

`path` is bound into the signature so a captured /signals signature
can't be replayed against /snapshot inside the 5-min skew window.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from typing import Any

import requests


def _config() -> tuple[str, str]:
    api_url = os.environ.get("GCIG_API_URL", "").rstrip("/")
    secret = os.environ.get("SEA_INGEST_SECRET", "")
    if not api_url:
        raise RuntimeError("GCIG_API_URL not set (e.g. https://gcig-api.onrender.com)")
    if not secret:
        raise RuntimeError("SEA_INGEST_SECRET not set")
    return api_url, secret


def _sign(secret: str, timestamp: str, path: str, body: bytes) -> str:
    msg = f"{timestamp}.{path}.".encode("ascii") + body
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _signed_headers(secret: str, path: str, body: bytes) -> dict[str, str]:
    ts = str(int(time.time()))
    return {
        "X-Sea-Timestamp": ts,
        "X-Sea-Signature": _sign(secret, ts, path, body),
    }


def post_signals(rows: list[dict[str, Any]]) -> dict:
    """POST /api/sea/signals — bulk-upsert signal rows.

    Each row: {"date": "YYYY-MM-DD", "name": str, "value": float | None}.
    """
    api_url, secret = _config()
    path = "/api/sea/signals"
    body = json.dumps({"signals": rows}, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        **_signed_headers(secret, path, body),
    }
    # 60s timeout absorbs Render free-tier cold starts (30-60s).
    resp = requests.post(f"{api_url}{path}", data=body, headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"signals POST failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()


def post_snapshot(payload: dict[str, Any]) -> dict:
    """POST /api/sea/snapshot — upsert the singleton snapshot row."""
    api_url, secret = _config()
    path = "/api/sea/snapshot"
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        **_signed_headers(secret, path, body),
    }
    resp = requests.post(f"{api_url}{path}", data=body, headers=headers, timeout=60)
    if resp.status_code >= 400:
        raise RuntimeError(f"snapshot POST failed: {resp.status_code} {resp.text[:200]}")
    return resp.json()
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd sea_tracker && python -m pytest tests/test_api_client.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add sea_tracker/api_client.py sea_tracker/tests/test_api_client.py
git commit -m "$(cat <<'EOF'
sea_tracker: HMAC-signed client for gcig-api

Mirrors the CPI pattern: separate SEA_INGEST_SECRET, separate
X-Sea-* headers, path-bound signature, 60s timeout for Render
cold-start absorption. Two surfaces — post_signals and post_snapshot
— both produce identical signature shapes that the server side
verifies in routes/sea.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Snapshot builder reading from DuckDB

**Files:**
- Create: `sea_tracker/snapshot.py`
- Create: `sea_tracker/tests/test_snapshot.py`

- [ ] **Step 1: Write the failing test**

The snapshot builder reads from DuckDB. Use a real in-memory DuckDB with a tiny seeded fixture for the test — that's the safest way to verify the SQL.

Create `sea_tracker/tests/test_snapshot.py`:

```python
from datetime import datetime, timedelta

import duckdb
import pytest

from sea_tracker.db import init_schema
from sea_tracker.snapshot import build_snapshot

BBOX = (23.5, 30.5, 47.5, 57.5)
NOW = datetime(2026, 5, 4, 20, 0, 0)


@pytest.fixture
def con():
    c = duckdb.connect(":memory:")
    init_schema(c)
    yield c
    c.close()


def _seed_vessel(con, mmsi, name, ship_type=80, length_m=320, beam_m=58, draught=18.0, size_class="vlcc"):
    con.execute(
        "INSERT INTO vessels (mmsi, name, ship_type, length_m, beam_m, draught_m_max, size_class, last_seen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [mmsi, name, ship_type, length_m, beam_m, draught, size_class, NOW],
    )


def _seed_position(con, mmsi, lat, lon, ts, sog=10.0, cog=90.0, heading=90):
    con.execute(
        "INSERT INTO ais_messages (ts, mmsi, msg_type, lat, lon, sog, cog, heading) "
        "VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
        [ts, mmsi, lat, lon, sog, cog, heading],
    )


def _seed_signal(con, day, name, value):
    con.execute(
        "INSERT INTO signals_daily (date, signal_name, value) VALUES (?, ?, ?)",
        [day, name, value],
    )


def test_empty_db_returns_minimal_payload(con):
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["bbox"] == list(BBOX)
    assert out["vessels"] == []
    assert out["signals"] == {}
    assert isinstance(out["terminals"], list) and len(out["terminals"]) > 0


def test_vessel_inside_bbox_and_recent_appears(con):
    _seed_vessel(con, 1, "TANKER ONE")
    _seed_position(con, 1, lat=26.0, lon=52.0, ts=NOW - timedelta(minutes=5))
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert len(out["vessels"]) == 1
    v = out["vessels"][0]
    assert v["mmsi"] == 1
    assert v["name"] == "TANKER ONE"
    assert v["sizeClass"] == "vlcc"
    assert v["lat"] == 26.0 and v["lon"] == 52.0


def test_vessel_outside_bbox_is_dropped(con):
    _seed_vessel(con, 2, "OUT OF BOX")
    _seed_position(con, 2, lat=10.0, lon=10.0, ts=NOW - timedelta(minutes=5))
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["vessels"] == []


def test_stale_vessel_is_dropped(con):
    _seed_vessel(con, 3, "STALE")
    _seed_position(con, 3, lat=26.0, lon=52.0, ts=NOW - timedelta(hours=2))
    out = build_snapshot(con, bbox=BBOX, now=NOW, freshness_minutes=30)
    assert out["vessels"] == []


def test_trail_built_and_thinned(con):
    _seed_vessel(con, 4, "TRAIL")
    # Last position fresh
    _seed_position(con, 4, lat=26.5, lon=52.5, ts=NOW - timedelta(minutes=2))
    # 50 historical points across 24h, all collinear so RDP collapses them
    for i in range(50):
        t = NOW - timedelta(hours=24) + timedelta(minutes=i * 28)
        lat = 26.0 + 0.01 * i
        lon = 52.0 + 0.01 * i
        _seed_position(con, 4, lat=lat, lon=lon, ts=t)
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    v = out["vessels"][0]
    assert "trail" in v
    assert len(v["trail"]) <= 200
    assert len(v["trail"]) >= 1
    # First and last entries are tuples [lat, lon, iso_ts]
    first = v["trail"][0]
    assert isinstance(first, list) and len(first) == 3


def test_latest_signal_per_name_is_picked(con):
    _seed_signal(con, "2026-05-02", "anchored_tanker_count", 7.0)
    _seed_signal(con, "2026-05-03", "anchored_tanker_count", 9.0)
    _seed_signal(con, "2026-05-03", "hormuz_outbound_laden_count", 14.0)
    out = build_snapshot(con, bbox=BBOX, now=NOW)
    assert out["signals"]["anchored_tanker_count"]["value"] == 9.0
    assert out["signals"]["anchored_tanker_count"]["asOf"] == "2026-05-03"
    assert out["signals"]["hormuz_outbound_laden_count"]["value"] == 14.0
```

- [ ] **Step 2: Run the test — expect ImportError**

```bash
cd sea_tracker && python -m pytest tests/test_snapshot.py -v
```

Expected: collection error, `sea_tracker.snapshot` does not exist.

- [ ] **Step 3: Implement `sea_tracker/snapshot.py`**

```python
"""Build the rolling snapshot payload published to gcig-api.

Reads from DuckDB (in another process the collector is writing to it
concurrently — DuckDB allows many readers + one writer). Produces the
shape the React /tankers page consumes verbatim, plus enough metadata
that the server side can stamp it and persist as JSONB.

Pricey or stateful work: don't do any here. This must run in a few
seconds even when the bbox holds a thousand vessels.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import duckdb

from sea_tracker.geo import TERMINALS
from sea_tracker.rdp import thin_trail

# The seven daily signals defined in signals.py — kept in sync with
# what `compute_daily_signals` writes to signals_daily. The map page
# expects every key to be present (panel cards key off this list).
_SIGNAL_NAMES = [
    "hormuz_outbound_laden_count",
    "hormuz_outbound_dwt_proxy",
    "hormuz_inbound_ballast_count",
    "gulf_laden_ballast_ratio",
    "anchored_tanker_count",
    "gulf_total_dwt_proxy",
    "terminal_departures_saudi",
    "terminal_departures_iran",
    "terminal_departures_kuwait",
    "terminal_departures_iraq",
    "terminal_departures_uae",
    "terminal_departures_qatar",
]


def _latest_position_per_vessel(
    con: duckdb.DuckDBPyConnection, *, bbox, now: datetime, freshness_minutes: int
):
    lat_min, lat_max, lon_min, lon_max = bbox
    cutoff = now - timedelta(minutes=freshness_minutes)
    return con.execute(
        """
        WITH latest AS (
            SELECT mmsi, MAX(ts) AS ts FROM ais_messages
            WHERE lat IS NOT NULL AND lon IS NOT NULL
              AND ts >= ?
              AND lat BETWEEN ? AND ?
              AND lon BETWEEN ? AND ?
            GROUP BY mmsi
        )
        SELECT m.mmsi, m.ts, m.lat, m.lon, m.sog, m.cog, m.heading,
               v.name, v.ship_type, v.size_class, v.draught_m_max
        FROM latest l
        JOIN ais_messages m ON m.mmsi = l.mmsi AND m.ts = l.ts
        LEFT JOIN vessels v ON v.mmsi = m.mmsi
        """,
        [cutoff, lat_min, lat_max, lon_min, lon_max],
    ).fetchall()


def _trail_for_mmsi(
    con: duckdb.DuckDBPyConnection, mmsi: int, *, now: datetime, hours: int
) -> list[tuple[float, float, datetime]]:
    cutoff = now - timedelta(hours=hours)
    return con.execute(
        """
        SELECT lat, lon, ts
        FROM ais_messages
        WHERE mmsi = ?
          AND ts >= ?
          AND lat IS NOT NULL AND lon IS NOT NULL
        ORDER BY ts ASC
        """,
        [mmsi, cutoff],
    ).fetchall()


def _laden_for(size_class: str | None, draught: float | None) -> bool | None:
    if size_class is None or draught is None:
        return None
    thresholds = {"vlcc": 17.0, "suezmax": 13.5, "aframax": 11.0, "small": 8.0}
    t = thresholds.get(size_class)
    if t is None:
        return None
    return draught >= t


def _latest_signal_values(con: duckdb.DuckDBPyConnection) -> dict[str, dict[str, Any]]:
    rows = con.execute(
        """
        SELECT signal_name, date, value
        FROM signals_daily
        WHERE (signal_name, date) IN (
            SELECT signal_name, MAX(date)
            FROM signals_daily
            GROUP BY signal_name
        )
        """,
    ).fetchall()
    out: dict[str, dict[str, Any]] = {}
    for name, day, value in rows:
        if name not in _SIGNAL_NAMES:
            continue
        out[name] = {"value": value, "asOf": day.isoformat() if day else None}
    return out


def build_snapshot(
    con: duckdb.DuckDBPyConnection,
    *,
    bbox: tuple[float, float, float, float],
    now: datetime,
    freshness_minutes: int = 30,
    trail_hours: int = 24,
    trail_tolerance_deg: float = 0.0005,  # ~50 m at this latitude
    trail_max_points: int = 200,
) -> dict[str, Any]:
    """Return the JSON-serializable payload posted to /api/sea/snapshot."""
    rows = _latest_position_per_vessel(
        con, bbox=bbox, now=now, freshness_minutes=freshness_minutes
    )
    vessels: list[dict[str, Any]] = []
    for (
        mmsi, ts, lat, lon, sog, cog, heading,
        name, ship_type, size_class, draught,
    ) in rows:
        trail_raw = _trail_for_mmsi(con, mmsi, now=now, hours=trail_hours)
        trail_thinned = thin_trail(
            trail_raw,
            tolerance_deg=trail_tolerance_deg,
            max_points=trail_max_points,
        )
        trail_serial = [
            [float(t[0]), float(t[1]), t[2].isoformat() + "Z"]
            for t in trail_thinned
        ]
        vessels.append({
            "mmsi": int(mmsi),
            "name": name,
            "shipType": ship_type,
            "sizeClass": size_class,
            "laden": _laden_for(size_class, draught),
            "lat": float(lat),
            "lon": float(lon),
            "sog": float(sog) if sog is not None else None,
            "cog": float(cog) if cog is not None else None,
            "heading": int(heading) if heading is not None else None,
            "lastSeen": ts.isoformat() + "Z",
            "trail": trail_serial,
        })

    terminals = [
        {"name": n, "country": c, "lat": clat, "lon": clon, "radiusKm": r}
        for n, c, clat, clon, r in TERMINALS
    ]

    return {
        "bbox": [bbox[0], bbox[1], bbox[2], bbox[3]],
        "vessels": vessels,
        "terminals": terminals,
        "signals": _latest_signal_values(con),
    }
```

- [ ] **Step 4: Run the test — expect pass**

```bash
cd sea_tracker && python -m pytest tests/test_snapshot.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add sea_tracker/snapshot.py sea_tracker/tests/test_snapshot.py
git commit -m "$(cat <<'EOF'
sea_tracker: snapshot builder for /api/sea/snapshot

Reads latest-fresh position per vessel inside the bbox, attaches a
24h Douglas-Peucker-thinned trail per vessel, folds in latest values
for the seven signals defined in signals.py. Stays a few seconds
even at full bbox load. Tests use a real in-memory DuckDB so the
SQL — including the per-vessel-latest CTE — is exercised end to end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: publish wrapper + CLI commands

**Files:**
- Create: `sea_tracker/publish.py`
- Modify: `sea_tracker/cli.py`

- [ ] **Step 1: Create `sea_tracker/publish.py`**

```python
"""Thin wrapper around api_client. Kept separate from cli.py so the
typer command bodies stay readable and so tests can monkeypatch a
single import target."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import duckdb

from sea_tracker.api_client import post_signals as _post_signals
from sea_tracker.api_client import post_snapshot as _post_snapshot
from sea_tracker.snapshot import build_snapshot


def publish_signals_window(con: duckdb.DuckDBPyConnection, *, days: int) -> dict:
    """Read signals_daily for the last `days` and POST them in one call."""
    cutoff = date.today() - timedelta(days=days)
    rows = con.execute(
        "SELECT date, signal_name, value FROM signals_daily WHERE date >= ? ORDER BY date",
        [cutoff],
    ).fetchall()
    payload = [
        {"date": d.isoformat(), "name": name, "value": value}
        for d, name, value in rows
    ]
    return _post_signals(payload)


def publish_snapshot_now(
    con: duckdb.DuckDBPyConnection,
    *,
    bbox: tuple[float, float, float, float],
    now,
) -> dict:
    snap = build_snapshot(con, bbox=bbox, now=now)
    payload: dict[str, Any] = {
        "snapshotAt": now.isoformat() + "Z",
        "vesselCount": len(snap["vessels"]),
        "payload": snap,
    }
    return _post_snapshot(payload)
```

- [ ] **Step 2: Add CLI commands in `sea_tracker/cli.py`**

Open `sea_tracker/cli.py`. Find the line:

```python
from sea_tracker.signals import compute_signals_range
```

Add directly below it:

```python
from sea_tracker.publish import publish_signals_window, publish_snapshot_now
```

Then append two new typer commands above `if __name__ == "__main__":`:

```python
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
```

- [ ] **Step 3: Verify the CLI loads**

```bash
cd sea_tracker && python -m sea_tracker.cli --help
```

Expected: help output that includes `publish-signals` and `publish-snapshot` alongside the existing commands.

- [ ] **Step 4: Run the full test suite**

```bash
cd sea_tracker && python -m pytest -v
```

Expected: all tests pass (rdp + api_client + snapshot).

- [ ] **Step 5: Commit**

```bash
git add sea_tracker/publish.py sea_tracker/cli.py
git commit -m "$(cat <<'EOF'
sea_tracker: publish-signals and publish-snapshot CLI commands

Two new typer entries fronting api_client + snapshot:

  sea_tracker publish-signals --days 90
  sea_tracker publish-snapshot

Run from Task Scheduler on the Windows server — daily for signals
after enrich+signals, every two minutes for snapshots. publish.py
keeps the typer command bodies tidy and gives tests a single
monkeypatch target.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Windows server install + service docs

**Files:**
- Create: `sea_tracker/README.md`

- [ ] **Step 1: Write the README**

Create `sea_tracker/README.md`:

```markdown
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

   Fill in `aisstream.api_key`. Save.

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

## Generate the shared HMAC secret

Run once on the mac:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste that value into:

- Render dashboard → gcig-api → Environment → `SEA_INGEST_SECRET`
- `C:\sea_tracker\.env` on the Windows box

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

Trigger: Daily, 04:30 server local time. (Windows runs in your server's
local TZ. If the server is in UTC, set 09:30 instead.)

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
for indefinite duration". Settings tab: tick "Stop the task if it runs
longer than 2 minutes" to avoid pile-ups, and "If the task is already
running, do not start a new instance".

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
```

- [ ] **Step 2: Commit**

```bash
git add sea_tracker/README.md
git commit -m "$(cat <<'EOF'
sea_tracker: Windows install + service docs

Step-by-step from python.org install through NSSM service setup and
two Task Scheduler entries (daily batch, 2-min snapshot). Lists the
known DuckDB single-writer constraint, yfinance rate-limit fall-
through, and AISStream endpoint rotation gotcha so re-running this
in a year does not require re-discovering them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: React API wrapper

**Files:**
- Create: `client/src/api/sea.js`

- [ ] **Step 1: Create the wrapper**

Read the existing `client/src/api/cpi.js` (or whichever similar wrapper exists in `client/src/api/`) so the new file follows the same axios pattern. Then create `client/src/api/sea.js`:

```javascript
// Tanker Tracker API wrapper.
// Both endpoints are JWT-authed; auth headers + token rotation are
// handled by the shared axios instance in client.js.

import api from './client';

export async function getLatestSnapshot() {
  const { data } = await api.get('/sea/latest');
  return data;
}

export async function getSignalHistory(signalName, days = 90) {
  const { data } = await api.get('/sea/history', {
    params: { signal: signalName, days },
  });
  return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/api/sea.js
git commit -m "$(cat <<'EOF'
client: sea api wrapper

Two read-only calls — getLatestSnapshot and getSignalHistory — over
the shared axios instance so JWT bearer + silent rotation are free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Install MapLibre

**Files:**
- Modify: `client/package.json`, `client/package-lock.json`

- [ ] **Step 1: Install**

```bash
cd client && npm install maplibre-gl@^4.7.0
```

- [ ] **Step 2: Verify it builds**

```bash
cd client && npm run build
```

Expected: build succeeds. (The dependency is just installed, not yet imported anywhere — Vite should still build cleanly.)

- [ ] **Step 3: Commit**

```bash
git add client/package.json client/package-lock.json
git commit -m "$(cat <<'EOF'
client: add maplibre-gl

Map library for the upcoming /tankers page. Free, no API key, ~700KB
gzipped. We render against OpenStreetMap raster tiles (also free, no
key) so this stays inside the project rule of no paid map APIs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Signal panel components

**Files:**
- Create: `client/src/pages/tankers/SignalCard.jsx`
- Create: `client/src/pages/tankers/SignalPanel.jsx`

- [ ] **Step 1: Create `client/src/pages/tankers/SignalCard.jsx`**

```jsx
import { useEffect, useState } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { getSignalHistory } from '../../api/sea';

const LABELS = {
  hormuz_outbound_laden_count: 'Hormuz Outbound (Laden)',
  hormuz_outbound_dwt_proxy: 'Hormuz Outbound DWT Proxy',
  hormuz_inbound_ballast_count: 'Hormuz Inbound (Ballast)',
  gulf_laden_ballast_ratio: 'Gulf Laden / Ballast Ratio',
  anchored_tanker_count: 'Anchored Tankers',
  gulf_total_dwt_proxy: 'Gulf Total DWT Proxy',
  terminal_departures_saudi: 'Saudi Terminal Departures',
  terminal_departures_iran: 'Iran Terminal Departures',
  terminal_departures_kuwait: 'Kuwait Terminal Departures',
  terminal_departures_iraq: 'Iraq Terminal Departures',
  terminal_departures_uae: 'UAE Terminal Departures',
  terminal_departures_qatar: 'Qatar Terminal Departures',
};

// Format a single signal value. Ratios as %, DWT proxies in compact
// notation, everything else as integers. Keeps panel cards uniform
// without each signal needing bespoke logic.
function formatValue(name, value) {
  if (value === null || value === undefined) return '—';
  if (name === 'gulf_laden_ballast_ratio') {
    return `${(value * 100).toFixed(0)}%`;
  }
  if (name.endsWith('_dwt_proxy')) {
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

export default function SignalCard({ name, value, asOf }) {
  const [series, setSeries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getSignalHistory(name, 90)
      .then((res) => { if (!cancelled) setSeries(res.points || []); })
      .catch(() => { if (!cancelled) setSeries([]); });
    return () => { cancelled = true; };
  }, [name]);

  return (
    <div className="rounded-2xl border border-navy/10 bg-white p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-navy/60">
        {LABELS[name] || name}
      </div>
      <div className="mt-1 text-2xl font-semibold text-navy">
        {formatValue(name, value)}
      </div>
      <div className="mt-2 h-12">
        {series && series.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <YAxis hide domain={['auto', 'auto']} />
              <Line
                type="monotone"
                dataKey="value"
                stroke="#C9A84C"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full rounded bg-navy/5" />
        )}
      </div>
      <div className="mt-2 text-[10px] uppercase tracking-wider text-navy/40">
        {asOf ? `as of ${asOf}` : '—'}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `client/src/pages/tankers/SignalPanel.jsx`**

```jsx
import SignalCard from './SignalCard';

const ORDER = [
  'hormuz_outbound_laden_count',
  'hormuz_inbound_ballast_count',
  'anchored_tanker_count',
  'gulf_laden_ballast_ratio',
  'hormuz_outbound_dwt_proxy',
  'gulf_total_dwt_proxy',
  'terminal_departures_saudi',
  'terminal_departures_iran',
  'terminal_departures_uae',
  'terminal_departures_kuwait',
  'terminal_departures_iraq',
  'terminal_departures_qatar',
];

export default function SignalPanel({ signals }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {ORDER.map((name) => {
        const entry = (signals || {})[name] || {};
        return (
          <SignalCard
            key={name}
            name={name}
            value={entry.value}
            asOf={entry.asOf}
          />
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/tankers/SignalCard.jsx client/src/pages/tankers/SignalPanel.jsx
git commit -m "$(cat <<'EOF'
client: tanker tracker signal panel

12-card grid keyed by the seven base signals plus the six per-country
terminal-departure series. Each card lazy-loads its own 90-day
sparkline from /api/sea/history; formatting picks integer / percent /
compact-DWT based on the signal name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Vessel map component

**Files:**
- Create: `client/src/pages/tankers/VesselMap.jsx`

- [ ] **Step 1: Create the map**

```jsx
import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const SIZE_COLORS = {
  vlcc: '#C9A84C',
  suezmax: '#1B2A4A',
  aframax: '#5B6B89',
  small: '#9CA3AF',
  unknown: '#9CA3AF',
};

// Free OpenStreetMap raster style. Comes with a sensible attribution
// requirement which MapLibre renders automatically.
const RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export default function VesselMap({ snapshot, onVesselClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const dataRef = useRef({ vessels: [], terminals: [], bbox: null });

  // Initialize once.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: RASTER_STYLE,
      center: [52.5, 26.5],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource('vessels', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('terminals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

      map.addLayer({
        id: 'trails-line',
        type: 'line',
        source: 'trails',
        paint: {
          'line-color': '#1B2A4A',
          'line-width': 1,
          'line-opacity': 0.25,
        },
      });

      map.addLayer({
        id: 'vessels-dot',
        type: 'circle',
        source: 'vessels',
        paint: {
          'circle-radius': 5,
          'circle-color': ['coalesce', ['get', 'color'], '#9CA3AF'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      map.addLayer({
        id: 'terminals-pin',
        type: 'circle',
        source: 'terminals',
        paint: {
          'circle-radius': 6,
          'circle-color': '#C9A84C',
          'circle-stroke-color': '#1B2A4A',
          'circle-stroke-width': 2,
        },
      });

      map.on('click', 'vessels-dot', (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const props = feat.properties || {};
        const vessel = dataRef.current.vessels.find((v) => v.mmsi === Number(props.mmsi));
        if (vessel && onVesselClick) onVesselClick(vessel);
      });
      map.on('mouseenter', 'vessels-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'vessels-dot', () => { map.getCanvas().style.cursor = ''; });
    });

    return () => map.remove();
  }, [onVesselClick]);

  // Push data whenever the snapshot changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !snapshot) return;
    dataRef.current = snapshot;

    const apply = () => {
      const vesselFeatures = (snapshot.vessels || []).map((v) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
        properties: {
          mmsi: v.mmsi,
          color: SIZE_COLORS[v.sizeClass || 'unknown'] || SIZE_COLORS.unknown,
        },
      }));
      const trailFeatures = (snapshot.vessels || [])
        .filter((v) => Array.isArray(v.trail) && v.trail.length >= 2)
        .map((v) => ({
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: v.trail.map(([lat, lon]) => [lon, lat]),
          },
          properties: { mmsi: v.mmsi },
        }));
      const terminalFeatures = (snapshot.terminals || []).map((t) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        properties: { name: t.name, country: t.country },
      }));

      const v = map.getSource('vessels');
      const tr = map.getSource('trails');
      const te = map.getSource('terminals');
      if (v) v.setData({ type: 'FeatureCollection', features: vesselFeatures });
      if (tr) tr.setData({ type: 'FeatureCollection', features: trailFeatures });
      if (te) te.setData({ type: 'FeatureCollection', features: terminalFeatures });
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [snapshot]);

  return (
    <div
      ref={containerRef}
      className="h-[600px] w-full rounded-2xl border border-navy/10 shadow-sm"
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/tankers/VesselMap.jsx
git commit -m "$(cat <<'EOF'
client: tanker tracker map component

MapLibre + free OpenStreetMap raster tiles (no key). Three GeoJSON
sources — vessels (dots, sized colored by class), trails (faint
polylines), terminals (gold pins). Clicking a vessel dot bubbles the
full vessel object up via onVesselClick so the page can open the
detail drawer. Single style/layer init, then setData on every
snapshot change — the source-of-truth pattern keeps re-renders cheap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Vessel detail drawer

**Files:**
- Create: `client/src/pages/tankers/VesselDrawer.jsx`

- [ ] **Step 1: Create the drawer**

```jsx
import { X } from 'lucide-react';

const SIZE_LABELS = {
  vlcc: 'VLCC',
  suezmax: 'Suezmax',
  aframax: 'Aframax',
  small: 'Small / Other',
  unknown: '—',
};

function row(label, value) {
  return (
    <div className="flex justify-between border-b border-navy/5 py-2 text-sm">
      <span className="text-navy/60">{label}</span>
      <span className="font-medium text-navy">{value}</span>
    </div>
  );
}

export default function VesselDrawer({ vessel, onClose }) {
  if (!vessel) return null;
  const headingDeg = Number.isFinite(vessel.heading) ? `${vessel.heading}°` : '—';
  return (
    <div className="fixed right-0 top-0 z-40 h-full w-full max-w-sm overflow-y-auto border-l border-navy/10 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-navy/10 px-5 py-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-navy/50">Vessel</div>
          <div className="text-lg font-semibold text-navy">{vessel.name || `MMSI ${vessel.mmsi}`}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-navy/60 hover:bg-navy/5 hover:text-navy"
          aria-label="Close vessel detail"
        >
          <X size={18} />
        </button>
      </div>
      <div className="px-5 py-3">
        {row('MMSI', vessel.mmsi)}
        {row('Type', vessel.shipType ?? '—')}
        {row('Class', SIZE_LABELS[vessel.sizeClass || 'unknown'])}
        {row('Laden', vessel.laden === true ? 'Yes' : vessel.laden === false ? 'No' : '—')}
        {row('Speed', vessel.sog == null ? '—' : `${vessel.sog.toFixed(1)} kn`)}
        {row('Course', vessel.cog == null ? '—' : `${vessel.cog.toFixed(0)}°`)}
        {row('Heading', headingDeg)}
        {row('Last seen', vessel.lastSeen ? new Date(vessel.lastSeen).toLocaleString() : '—')}
      </div>
      <div className="px-5 py-4">
        <a
          className="inline-block rounded-lg bg-navy px-3 py-2 text-sm font-medium text-white hover:bg-navy/90"
          href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${vessel.mmsi}`}
          target="_blank"
          rel="noreferrer"
        >
          View on MarineTraffic
        </a>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add client/src/pages/tankers/VesselDrawer.jsx
git commit -m "$(cat <<'EOF'
client: tanker tracker vessel detail drawer

Right-side panel with name / MMSI / class / laden / sog-cog-heading /
last-seen, plus a MarineTraffic deep link for anyone curious to see
the vessel's full track. Mounted by Tankers.jsx as a portal-ish
overlay; closes on the X button.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Tankers page + route + sidebar

**Files:**
- Create: `client/src/pages/Tankers.jsx`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/Sidebar.jsx`

- [ ] **Step 1: Create the page shell**

`client/src/pages/Tankers.jsx`:

```jsx
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getLatestSnapshot } from '../api/sea';
import SignalPanel from './tankers/SignalPanel';
import VesselMap from './tankers/VesselMap';
import VesselDrawer from './tankers/VesselDrawer';

const POLL_MS = 30 * 1000;

function relativeTime(iso) {
  if (!iso) return 'never';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export default function Tankers() {
  const [snapshot, setSnapshot] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedVessel, setSelectedVessel] = useState(null);

  async function refresh() {
    try {
      const res = await getLatestSnapshot();
      setConfigured(res.configured !== false);
      setSnapshot(res.snapshot || null);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let timer = null;
    async function tick() {
      if (!alive) return;
      await refresh();
      if (alive) timer = setTimeout(tick, POLL_MS);
    }
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-navy">Tanker Tracker</h1>
          <p className="text-sm text-navy/60">
            Persian Gulf oil-tanker positions and signals, refreshed every 2 min.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-navy/60">
          <span>Last update: {relativeTime(snapshot?.snapshotAt)}</span>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1 rounded-lg border border-navy/10 px-2 py-1 hover:bg-navy/5"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {loading && <div className="text-sm text-navy/60">Loading…</div>}

      {!loading && !configured && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Tanker tracker is not configured yet — no snapshots have been received from the
          collector. Once the Windows-side <code>publish-snapshot</code> task starts running,
          data will appear here.
        </div>
      )}

      {!loading && error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          {error}
        </div>
      )}

      {snapshot && (
        <>
          <SignalPanel signals={snapshot.signals} />
          <VesselMap snapshot={snapshot} onVesselClick={setSelectedVessel} />
          <VesselDrawer vessel={selectedVessel} onClose={() => setSelectedVessel(null)} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the `/tankers` route in `client/src/App.jsx`**

Find the existing `<Route path="/cpi" element={<CPI />} />` line. Add a new import alongside the other page imports near the top of the file:

```javascript
import Tankers from './pages/Tankers';
```

Add the route directly below the CPI route:

```jsx
<Route path="/tankers" element={<Tankers />} />
```

- [ ] **Step 3: Add the sidebar entry in `client/src/components/Sidebar.jsx`**

Find the line `{ to: '/cpi', label: 'CPI Forecast', icon: Activity },`. The Macro group ends with that entry. Add a new line directly below:

```javascript
{ to: '/tankers', label: 'Tanker Tracker', icon: Ship },
```

Then make sure `Ship` is imported from `lucide-react`. Find the existing `lucide-react` import block at the top of the file and append `Ship` to the destructuring (alphabetical ordering preserved — drop it next to `ShieldAlert`).

- [ ] **Step 4: Manual smoke test**

```bash
# Terminal 1 — server
cd server && npm run dev

# Terminal 2 — client
cd client && npm run dev
```

Open http://localhost:5173, log in, click "Tanker Tracker" in the sidebar.

Expected before the first publish from the Windows server: yellow "not configured yet" banner. That is correct.

Seed a fake snapshot to verify the rendering path before the Windows side is live:

```bash
SECRET=$(grep '^SEA_INGEST_SECRET=' server/.env | cut -d= -f2)
TS=$(date +%s)
PATH_SIG="/api/sea/snapshot"
BODY=$(node -e '
const payload = {
  snapshotAt: new Date().toISOString(),
  vesselCount: 1,
  payload: {
    bbox: [23.5, 30.5, 47.5, 57.5],
    vessels: [{
      mmsi: 123456789, name: "TEST TANKER", shipType: 80,
      sizeClass: "vlcc", laden: true,
      lat: 26.5, lon: 52.5, sog: 12.4, cog: 87, heading: 88,
      lastSeen: new Date().toISOString(),
      trail: [[26.0,52.0,"2026-05-04T10:00:00Z"],[26.5,52.5,"2026-05-04T20:00:00Z"]]
    }],
    terminals: [{name:"ras_tanura",country:"saudi",lat:26.65,lon:50.17,radiusKm:8.0}],
    signals: { hormuz_outbound_laden_count: { value: 14, asOf: "2026-05-03" } }
  }
};
process.stdout.write(JSON.stringify(payload));
')
SIG=$(printf '%s.%s.%s' "$TS" "$PATH_SIG" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -s -X POST http://localhost:4000/api/sea/snapshot \
  -H "Content-Type: application/json" \
  -H "X-Sea-Timestamp: $TS" \
  -H "X-Sea-Signature: $SIG" \
  -d "$BODY"
```

Reload `/tankers` — banner should disappear, the test tanker dot should appear in the Persian Gulf, and clicking it should open the drawer.

Run a build to catch JSX/Vite errors:

```bash
cd client && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Tankers.jsx client/src/App.jsx client/src/components/Sidebar.jsx
git commit -m "$(cat <<'EOF'
client: /tankers page, route, and sidebar entry

Polling shell (every 30s) over getLatestSnapshot, then the panel,
map, and drawer compose into the page. Sensible empty-state copy
when the collector hasn't published yet (the band-aid for first-time
deploys before Task Scheduler runs publish-snapshot once). Sidebar
gets a Ship icon next to CPI Forecast in the Macro group.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Render env var rollout (manual checklist)

This is operational, not a code change. Surface it in the plan so the implementer doesn't ship the code without setting up the secret.

- [ ] **Step 1: Generate the shared HMAC secret on the mac**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the hex value.

- [ ] **Step 2: Set it on Render**

Open the Render dashboard → `gcig-api` service → Environment. Add:

```
SEA_INGEST_SECRET=<the hex>
```

Save (Render redeploys automatically).

- [ ] **Step 3: Set the same value in `C:\sea_tracker\.env` on the Windows server**

Per the README in Task 8.

- [ ] **Step 4: Update CLAUDE.md "Notable services / files" section**

Open `CLAUDE.md` and add to the "Notable services / files" list:

```
- `server/src/routes/sea.js` — HMAC ingest + JWT reads for the
  Tanker Tracker. Mirrors `cpi.js`. Off-platform Python publisher
  lives in `sea_tracker/` and runs on the Windows server.
```

Also append to "Stack → External APIs":

```
- AISStream (free, no auth needed for our bbox volume) — websocket
  consumed only on the Windows server, never proxied.
```

And under "Production" add:

```
- Tanker Tracker pipeline: `sea_tracker` Python package on the
  Windows server. Collector runs as NSSM service; daily and 2-min
  publish jobs in Task Scheduler. Setup docs at
  `sea_tracker/README.md`.
```

- [ ] **Step 5: Commit the CLAUDE.md edits and push**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
claude.md: tanker tracker notes

Pin where the new sea route lives, the AISStream off-platform model,
and the Windows-side runtime so future-Claude does not have to
re-derive the architecture from scratch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

Render auto-deploys gcig-api with the new schema + routes. Once the
Windows-side install is complete and `publish-snapshot` runs once,
`/tankers` lights up.

---

## Self-review

- **Spec coverage:** Each spec section maps to tasks:
  - Architecture diagram → Tasks 1, 2 (server) + 4–7 (Python) + 9–14 (client) + 8 (Windows) + 15 (Render env).
  - Prisma schema → Task 1.
  - API routes → Task 2.
  - Python publisher modules → Tasks 4 (rdp), 5 (api_client), 6 (snapshot), 7 (publish + cli).
  - Local config and scheduling → Tasks 3 (gitignore + example), 8 (NSSM + Task Scheduler README).
  - React page → Tasks 9, 10, 11, 12, 13, 14.
  - Out-of-scope items: not implemented (correct).
  - Success criteria: covered by Task 14 (smoke test) + Task 15 (Render rollout).

- **Placeholder scan:** No "TBD"/"TODO"/"appropriate error handling"/etc. Each step shows code or commands.

- **Type consistency:** `SeaSnapshot.payload` shape is the same across server (Task 2 routes — pass-through), Python (Task 6 `build_snapshot`), and React (Task 12 `VesselMap`, Task 13 `VesselDrawer`). Field names: `snapshotAt`, `vesselCount`, `vessels`, `terminals`, `signals`, vessel fields `mmsi/name/shipType/sizeClass/laden/lat/lon/sog/cog/heading/lastSeen/trail`. Confirmed identical in every task.

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-04-sea-tracker.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Fresh subagent per task with two-stage review between tasks. Best for plans of this size (15 tasks, three layers).

**2. Inline Execution** — Run tasks in this session with checkpoints for review.

Which approach?
