# Weather Radar (RDR) Terminal Panel

- **Date:** 2026-05-20
- **Status:** Approved (radar + NWS alerts; portfolio overlay deferred
  to v2). Lead-dev autonomy.
- **Scope:** A new `RDR` terminal function — a live US weather map:
  NEXRAD base-reflectivity radar + active NWS warning polygons,
  click-to-detail, legend, 5-minute auto-refresh, and a confab-safe AI
  brief. Sits alongside `WX` (which is the historical event-study
  playbook); RDR is real-time situational awareness.

## Why

`WX` answers "how have these baskets reacted to past landfalls." It
does not show what weather is happening *right now*. The user wants a
radar of current US weather events. NEXRAD reflectivity + NWS active
warnings is the standard situational-awareness view, and both feeds
are free and keyless. This is also a step toward the Bloomberg-vs-Google
goal: a v2 can badge holdings whose HQ state is under an active severe
warning (deferred — needs per-ticker HQ-state mapping from EDGAR).

## Data sources (all free, no key)

1. **NEXRAD radar tiles** — Iowa Environmental Mesonet (IEM) cached
   XYZ tile service, layer `nexrad-n0q-900913` (CONUS base reflectivity,
   N0Q product), EPSG:3857, 256px PNG tiles, refreshed server-side
   every ~5 min:
   `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`
   Loaded **directly by the browser** as a MapLibre raster source — so
   Render's datacenter-IP blocking (the GSAM/Yahoo wall) does not apply;
   these tiles render from the user's machine.

2. **NWS active alerts** — `https://api.weather.gov/alerts/active?status=actual&message_type=alert`,
   GeoJSON FeatureCollection. **Proxied through our API** because NWS
   requires a `User-Agent` header that a browser `fetch` cannot set
   (same reason we proxy SEC). Returns a FeatureCollection the client
   drops straight onto the map.

3. **Base map** — OpenFreeMap `positron` vector style
   (`https://tiles.openfreemap.org/styles/positron`), the same host the
   Tankers page already uses and which is already in the CSP allowlist.

## Architecture

### `server/src/services/wxAlerts.js` (new)

`export async function getActiveAlerts(deps = {})`:

- `const fetchImpl = deps.fetch || fetch;` so tests inject a fake.
- 3-minute module-level cache (`{ at, data }`) — NWS updates often but
  not every second; matches the radar's ~5-min cadence loosely.
- Fetches the active-alerts URL with headers
  `{ 'User-Agent': NWS_UA, Accept: 'application/geo+json' }` where
  `NWS_UA = process.env.NWS_UA || 'GCIG Terminal (https://thegriffinfund.org)'`.
- Normalizes each feature to
  `{ id, event, severity, headline, areaDesc, effective, expires, color }`
  and keeps the original `geometry`. `color` is derived from `event`
  via `colorForEvent()` (see below) so the client renders with a
  single `['get','color']` paint expression — no client-side color map.
- Splits into mapped (geometry is a non-null Polygon/MultiPolygon) and
  area-only (geometry null — county/zone-based advisories with no
  inline shape). Returns:
  ```js
  {
    asOf: <ISO>,
    total,                 // all active alerts
    mappedCount,           // alerts with inline polygons (on the map)
    areaOnlyCount,         // alerts without geometry (listed, not drawn)
    counts: { [event]: n },// per-event counts over MAPPED alerts
    features: { type:'FeatureCollection', features:[...] }, // mapped only,
                           // each feature.properties carries
                           // {id,event,severity,headline,areaDesc,expires,color}
    list: [ {id,event,severity,headline,areaDesc,expires} ]  // mapped, geom stripped,
                           // severity-sorted, for the sidebar
  }
  ```
- **Never-throws.** Any failure (fetch reject, non-2xx, bad JSON) logs
  `console.warn('wxAlerts degraded:', err.message)` and returns the
  empty shape (`total:0, …, features:{type:'FeatureCollection',features:[]}, list:[]`).

`colorForEvent(event)` — case-insensitive substring match on the event
string, first match wins, gray default:

| keyword | color | meaning |
|---------|-------|---------|
| `tornado` | `#ff2d2d` | tornado warning/watch |
| `severe thunderstorm` | `#ff8c00` | severe TS |
| `flood` / `flash flood` | `#2ecc71` | flooding |
| `hurricane` / `tropical` | `#ff5fa2` | tropical |
| `winter` / `blizzard` / `ice` / `snow` | `#4aa3ff` | winter wx |
| `heat` / `fire` / `red flag` | `#ffd23f` | heat / fire-weather |
| (default) | `#9aa0a6` | other |

### `server/src/services/wxAlerts.test.js` (new)

`node:test` + `node:assert/strict`, injected `fetch`. Cases:
- A FeatureCollection with one Tornado Warning (Polygon geometry) and
  one Winter Weather Advisory (`geometry: null`) →
  `total === 2`, `mappedCount === 1`, `areaOnlyCount === 1`,
  `counts['Tornado Warning'] === 1`, `features.features.length === 1`,
  and that feature's `properties.color === '#ff2d2d'`.
- `colorForEvent` table: a hand-built map of representative event
  strings → expected colors (one assertion per row above, plus an
  unknown event → `#9aa0a6`).
- Never-throws: injected `fetch` that rejects → empty shape, no throw.
- Never-throws: injected `fetch` resolving non-ok (`{ ok:false, status:503 }`)
  → empty shape.
- Never-throws: malformed JSON (features not an array) → empty shape.
- Cache: two calls within the TTL with a counting fake `fetch` → one
  upstream call (assert call count === 1).

Reset the module cache between tests via an exported `_resetWxAlerts()`
(mirror `_resetLiveQuotes` in liveQuotes.js).

### `server/src/routes/terminal.js` (modified)

- Import: `import { getActiveAlerts } from '../services/wxAlerts.js';`
- `KNOWN_FUNCTIONS`: add
  `{ id: 'RDR', label: 'Weather Radar', summary: 'Live US NEXRAD radar + active NWS warning polygons (tornado / severe TS / flood / winter / tropical).' }`
  placed next to the `WX` entry.
- Handler (exported, injectable, never-5xx — mirror `weatherImpactHandler`):
  ```js
  export async function weatherAlertsHandler(req, res, deps = {}) {
    const fetchAlerts = deps.getActiveAlerts || getActiveAlerts;
    try {
      res.json(await fetchAlerts());
    } catch (err) {
      console.warn('terminal/wx-alerts degraded:', err.message);
      res.json({
        asOf: new Date().toISOString(),
        total: 0, mappedCount: 0, areaOnlyCount: 0,
        counts: {},
        features: { type: 'FeatureCollection', features: [] },
        list: [],
      });
    }
  }
  ```
- Route: `router.get('/wx-alerts', (req, res) => weatherAlertsHandler(req, res));`
  next to `/weather-impact`. Stays inside the verifyJwt+executive
  terminal router (the client fetches it via the authed axios client —
  unlike the SEC proxy, no iframe is involved, so no special mounting).
- `FN_PROMPTS`: add an `RDR` entry. Tight prompt, same `GROUNDING_RULES`
  tail as the others:
  ```
  RDR:
    'You are a weather-risk analyst at GCIG, a student investment fund, reading a live snapshot of active US NWS warnings (the panel also shows NEXRAD radar). ' +
    'Write a 2–3 sentence brief. Lead with the most severe / highest-impact warnings (tornado, severe thunderstorm, flash flood) and roughly where they cluster by region or state from the area descriptions. Give counts by type. ' +
    'These are current conditions, not a forecast or a market call — describe the weather picture plainly and do not infer ticker-level impact unless the panel data names a holding. ' +
    GROUNDING_RULES,
  ```

### `server/src/routes/terminal.weatherAlerts.test.js` (new)

Route test mirroring `terminal.weatherImpact.test.js`: a mock `res`
(`{ json }`), inject `deps.getActiveAlerts`. Cases: returns the
service payload as-is on success; injected service that throws →
honest-empty 200 (never 5xx). (The service is never-throws, but the
route's own try/catch is still exercised here.)

### `client/src/terminal/functions/WeatherRadar.jsx` (new)

`export default function WeatherRadar()` — no props needed (no ticker;
`requires: null`).

MapLibre setup mirrors `client/src/pages/tankers/VesselMap.jsx`:
- `import maplibregl from 'maplibre-gl'; import 'maplibre-gl/dist/maplibre-gl.css';`
- Init once in a `useEffect([])`:
  - `new maplibregl.Map({ container, style: 'https://tiles.openfreemap.org/styles/positron', center: [-98.5, 39.5], zoom: 3.4, attributionControl: { compact: true } })`.
  - On `load`:
    - Add raster source `radar`:
      ```js
      map.addSource('radar', {
        type: 'raster', tileSize: 256,
        tiles: [`${RADAR_TILE_URL}?v=${radarVersion}`],
      });
      map.addLayer({ id:'radar', type:'raster', source:'radar',
        paint:{ 'raster-opacity': 0.6 } });
      ```
      where `RADAR_TILE_URL = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png'`.
    - Add empty geojson source `alerts` + two layers: `alerts-fill`
      (`type:'fill'`, `paint:{ 'fill-color':['get','color'], 'fill-opacity':0.25 }`)
      and `alerts-line` (`type:'line'`, `paint:{ 'line-color':['get','color'], 'line-width':1.5, 'line-opacity':0.9 }`).
    - Click handler on `alerts-fill` → `setSelected(feature.properties)`.
    - cursor pointer on enter/leave (same as VesselMap).
  - `return () => map.remove();`
- **Resize:** a `ResizeObserver` on the container calling `map.resize()`
  (the mosaic tile is user-resizable; without this the canvas keeps its
  initial size and clips). Disconnect on cleanup.
- Data: `useEffect([])` fetches `/terminal/wx-alerts` via the shared
  `api` client into state; pushes `data.features` to the `alerts`
  source via `getSource('alerts').setData(...)` (guard `isStyleLoaded`,
  else `map.once('load', …)`, same pattern as VesselMap).
- **Auto-refresh:** `setInterval(refresh, 5*60*1000)`. `refresh()`
  re-fetches alerts (setData) and bumps the radar version: remove the
  `radar` layer+source and re-add with a fresh `?v=<Date.now()>` to
  bust the browser tile cache (IEM serves "current" at the same path).
  Also a manual "↻ refresh" button in the header runs the same.
  `clearInterval` on cleanup.
- **AI brief:** confab-safe, mirroring `WeatherImpact.jsx` — only POST
  `/terminal/annotate` when `data && data.mappedCount + data.areaOnlyCount > 0`.
  Context lines: the per-event `counts`, the `areaOnlyCount`, and the
  top ~12 `list` rows (`event · severity · areaDesc · expires`). Render
  in a `.term-ai-block`. When there are zero active alerts nationwide,
  skip the call and show a muted "No active NWS warnings." line instead
  of inviting a fabricated brief. (Note: like every panel, the brief
  degrades to the server's "Data unavailable." when the LLM endpoint is
  unreachable — that is infra, not a panel bug.)
- **Layout:** root `.term-panel` with `style={{ height:'100%' }}`,
  header (`RDR` ticker + "Weather Radar · live" name + refresh button +
  "updated HH:MM"), then the map container `div` with
  `style={{ flex:1, minHeight:320, position:'relative' }}`. A small
  absolutely-positioned legend (color key + "+N area-based advisories
  not drawn" using `areaOnlyCount`) sits over the map's corner. When an
  alert is selected, a compact detail card (headline, areaDesc, expires,
  × to dismiss) overlays a map corner. AI brief block below the map.
- **Honest degrade:** if the alerts fetch fails, the radar map still
  renders; show an "NWS alerts unavailable" chip in the legend area.
  Map never blocks on the alerts call.

### `client/src/terminal/registry.js` (modified)

- `import WeatherRadar from './functions/WeatherRadar.jsx';`
- Add `{ id:'RDR', label:'Weather Radar', help:'Live US NEXRAD radar + active NWS warnings.', requires:null, component:WeatherRadar }`
  next to the `WX` entry.

### `render.yaml` (modified)

Add `https://mesonet.agron.iastate.edu` to BOTH `img-src` and
`connect-src` in the `gcig-client` CSP (MapLibre raster tiles load as
images; some code paths fetch them). OpenFreeMap and our API origin are
already present; NWS is proxied so it needs no CSP entry.

## Data flow

```
RDR panel mount
  ├─ MapLibre map → positron basemap (openfreemap)
  │    ├─ raster 'radar'  → IEM NEXRAD tiles  (browser → mesonet.agron.iastate.edu)
  │    └─ geojson 'alerts' ← GET /api/terminal/wx-alerts
  │                              (server → api.weather.gov, UA header)
  ├─ click polygon → detail card
  ├─ confab-safe brief → POST /api/terminal/annotate {function:'RDR'}
  └─ every 5 min → re-fetch alerts + bust radar tiles
```

## Error handling

Every layer degrades, never 5xx, never silently fakes:
- `getActiveAlerts` never-throws → honest-empty shape.
- Route wraps it anyway → honest-empty 200.
- Client: radar renders even if alerts fail; brief skipped when no
  alerts; "unavailable" chips instead of blank panels.
- LLM down → server "Data unavailable." (uniform across all panels).

## Testing

- **Server:** `npm test` green including the two new suites
  (`wxAlerts.test.js`, `terminal.weatherAlerts.test.js`). Hand-built
  GeoJSON fixtures inline in the tests; injected `fetch`/service so no
  live NWS call in CI.
- **Live sanity (from laptop, documented in the PR, not CI):**
  `curl -H 'User-Agent: GCIG Terminal (https://thegriffinfund.org)' 'https://api.weather.gov/alerts/active?status=actual&message_type=alert' | head`
  returns a FeatureCollection; a sample NEXRAD tile URL returns a PNG.
  NWS is an open government API and is not expected to block Render
  egress (unlike SEC/Yahoo/GSAM), but this is only fully confirmable in
  prod.
- **Client:** `npm run build` → `✓ built` (no client test harness);
  reasoned walkthrough — panel mounts, map paints basemap + radar,
  alerts draw as colored polygons, click → detail, legend shows
  area-only count, refresh re-fetches, AI brief renders or is skipped,
  unmount calls `map.remove()` (no leaked map), resize redraws.

## Build

Branch `feat/weather-radar` off latest `main`, TDD, subagent-driven,
one PR. Task order: (1) `wxAlerts` service + tests; (2) route + prompt
+ KNOWN_FUNCTIONS + route test; (3) `WeatherRadar.jsx` panel + registry;
(4) `render.yaml` CSP; final build + test sweep.

## Out of scope (v2+, honest)

- **Portfolio overlay** — badge holdings whose HQ state is under an
  active severe warning. Needs a ticker→HQ-state map (EDGAR
  `companyfacts`/`submissions` carries state of incorporation + business
  address). Real analytics value; deliberately deferred to keep v1 tight.
- **Radar animation loop** — IEM exposes timestamped layers
  (`nexrad-n0q-900913-YYYYMMDDHHMI`); a play/scrub control is a clean
  follow-up. v1 ships the current frame only.
- **Zone-geometry resolution** — drawing area-only advisories by
  resolving each `affectedZones` URL to its shape. Heavy (many fetches);
  v1 lists the count instead. The dramatic, map-worthy warnings (tornado
  / severe TS / flash flood) carry inline polygons and *do* draw.
- **Radar opacity slider** — trivial follow-up if wanted.
