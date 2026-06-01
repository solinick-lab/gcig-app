// Active US weather warnings for the RDR terminal panel. The map's
// radar layer (NEXRAD reflectivity) loads browser-side straight from
// the Iowa Mesonet tile cache, but the warning polygons come from the
// National Weather Service alerts API, which we have to proxy: NWS
// requires a User-Agent header that a browser fetch can't set, the
// same wall the SEC services work around. So this service is the one
// server hop — it pulls active alerts, normalizes them, and hands the
// client a FeatureCollection it can drop on the map untouched.
//
// Two honest distinctions baked into the output. Storm-based warnings
// (tornado, severe thunderstorm, flash flood) carry an inline polygon
// and get drawn; zone/county advisories (winter, heat) usually arrive
// with geometry:null — referenced by UGC code, no shape — so we count
// them but don't fabricate a polygon. And the whole thing is
// never-throws / honest-empty: any upstream hiccup degrades to a clean
// empty FeatureCollection so the panel still paints its radar.

const ALERTS_URL =
  'https://api.weather.gov/alerts/active?status=actual&message_type=alert';

// NWS asks every caller to identify itself; an anonymous or generic
// agent can draw a 403. Overridable so the deploy can carry a contact
// string per the NWS etiquette guidance.
const NWS_UA =
  process.env.NWS_UA || 'Griffin Fund Terminal (https://thegriffinfund.org)';

const TTL_MS = 3 * 60 * 1000; // NWS refreshes often; this loosely tracks
                              // the radar layer's ~5-min cadence.

// First keyword to match wins, so the more specific events are listed
// ahead of their broader cousins. Substring, case-insensitive.
const COLOR_RULES = [
  [['tornado'], '#ff2d2d'],
  [['severe thunderstorm'], '#ff8c00'],
  [['flood'], '#2ecc71'],
  [['hurricane', 'tropical'], '#ff5fa2'],
  [['winter', 'blizzard', 'ice', 'snow'], '#4aa3ff'],
  [['heat', 'fire', 'red flag'], '#ffd23f'],
];
const DEFAULT_COLOR = '#9aa0a6';

// Severity ranking for the sidebar sort — the NWS enum, most urgent
// first. Anything off-enum sinks to the bottom.
const SEVERITY_RANK = {
  Extreme: 0,
  Severe: 1,
  Moderate: 2,
  Minor: 3,
  Unknown: 4,
};

let cache = { at: 0, data: null };

export function _resetWxAlerts() {
  cache = { at: 0, data: null };
}

export function colorForEvent(event) {
  const e = String(event || '').toLowerCase();
  if (!e) return DEFAULT_COLOR;
  for (const [keywords, color] of COLOR_RULES) {
    if (keywords.some((k) => e.includes(k))) return color;
  }
  return DEFAULT_COLOR;
}

function emptyShape() {
  return {
    asOf: new Date().toISOString(),
    total: 0,
    mappedCount: 0,
    areaOnlyCount: 0,
    counts: {},
    features: { type: 'FeatureCollection', features: [] },
    list: [],
  };
}

// Pull the handful of fields the panel actually renders out of an NWS
// feature. `id` lives at the top level of the GeoJSON feature (a URN),
// everything else under properties.
function normalizeProps(feature) {
  const p = feature.properties || {};
  return {
    id: feature.id || p.id || '',
    event: p.event || 'Alert',
    severity: p.severity || 'Unknown',
    headline: p.headline || '',
    areaDesc: p.areaDesc || '',
    effective: p.effective || '',
    expires: p.expires || '',
    color: colorForEvent(p.event),
  };
}

function hasPolygon(geometry) {
  return (
    geometry &&
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
  );
}

export async function getActiveAlerts(deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const now = Date.now();
  if (cache.data && now - cache.at < TTL_MS) return cache.data;

  try {
    const res = await fetchImpl(ALERTS_URL, {
      headers: { 'User-Agent': NWS_UA, Accept: 'application/geo+json' },
    });
    if (!res || !res.ok) throw new Error(`NWS ${res ? res.status : 'no-response'}`);
    const json = await res.json();
    const features = Array.isArray(json?.features) ? json.features : [];

    const mapped = [];
    let areaOnlyCount = 0;
    const counts = {};

    for (const f of features) {
      if (hasPolygon(f?.geometry)) {
        const props = normalizeProps(f);
        mapped.push({ type: 'Feature', geometry: f.geometry, properties: props });
        counts[props.event] = (counts[props.event] || 0) + 1;
      } else {
        areaOnlyCount += 1;
      }
    }

    // Sidebar list: the mapped alerts, geometry dropped, most urgent
    // first (severity, then soonest-expiring as the tiebreak).
    const list = mapped
      .map((f) => {
        const { color, ...rest } = f.properties;
        return rest;
      })
      .sort((a, b) => {
        const ra = SEVERITY_RANK[a.severity] ?? 5;
        const rb = SEVERITY_RANK[b.severity] ?? 5;
        if (ra !== rb) return ra - rb;
        return String(a.expires).localeCompare(String(b.expires));
      });

    const data = {
      asOf: new Date().toISOString(),
      total: features.length,
      mappedCount: mapped.length,
      areaOnlyCount,
      counts,
      features: { type: 'FeatureCollection', features: mapped },
      list,
    };
    cache = { at: now, data };
    return data;
  } catch (err) {
    console.warn('wxAlerts degraded:', err.message);
    return emptyShape();
  }
}
