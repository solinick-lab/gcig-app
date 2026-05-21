import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import api from '../../api/client.js';

// RDR — Weather Radar. A live US map: NEXRAD base reflectivity under
// active NWS warning polygons. Two feeds, two paths. The radar tiles
// come straight from the Iowa Environmental Mesonet to the browser —
// they're public images, so there's no datacenter-IP wall (the one
// that blocks GSAM/Yahoo from Render) and no reason to proxy hundreds
// of tiles through our API. The warning polygons come from
// /terminal/wx-alerts, which is the one server hop, because NWS wants
// a User-Agent a browser fetch can't set. Distinct from WX (the
// historical landfall event-study): this is what's happening now.

// IEM's cached NEXRAD N0Q (base reflectivity) composite, web-mercator
// XYZ tiles, refreshed server-side ~every 5 min at the same path. We
// bust the browser cache on refresh with a ?v= bump rather than chasing
// IEM's timestamped layer names.
const RADAR_TILE_URL =
  'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const REFRESH_MS = 5 * 60 * 1000;

// Static legend — the colorForEvent buckets the server paints with.
const LEGEND = [
  ['Tornado', '#ff2d2d'],
  ['Severe T-storm', '#ff8c00'],
  ['Flood', '#2ecc71'],
  ['Tropical', '#ff5fa2'],
  ['Winter', '#4aa3ff'],
  ['Heat / Fire', '#ffd23f'],
];

function fmtClock(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// NWS expires is an ISO timestamp with an offset; a compact MM/DD HH:mm
// reads cleanly in the detail card.
function fmtExpires(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function WeatherRadar() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const radarVersionRef = useRef(0);

  const [data, setData] = useState(null);
  const [alertsErr, setAlertsErr] = useState(false);
  const [selected, setSelected] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  // (Re)install the radar raster layer with a fresh cache-busting
  // version, kept *under* the alert polygons so warnings stay legible.
  const installRadar = useCallback((map) => {
    if (!map || !map.isStyleLoaded()) return;
    radarVersionRef.current += 1;
    const v = radarVersionRef.current;
    if (map.getLayer('radar')) map.removeLayer('radar');
    if (map.getSource('radar')) map.removeSource('radar');
    map.addSource('radar', {
      type: 'raster',
      tileSize: 256,
      tiles: [`${RADAR_TILE_URL}?v=${v}`],
      attribution: 'NEXRAD via Iowa Environmental Mesonet',
    });
    const beforeId = map.getLayer('alerts-fill') ? 'alerts-fill' : undefined;
    map.addLayer(
      { id: 'radar', type: 'raster', source: 'radar', paint: { 'raster-opacity': 0.6 } },
      beforeId
    );
  }, []);

  const fetchAlerts = useCallback(() => {
    return api
      .get('/terminal/wx-alerts')
      .then(({ data: payload }) => {
        setData(payload);
        setAlertsErr(false);
        setUpdatedAt(payload?.asOf || new Date().toISOString());
      })
      .catch(() => {
        // Radar still renders; only the polygons are missing.
        setAlertsErr(true);
        setUpdatedAt(new Date().toISOString());
      });
  }, []);

  // Initialize the map once.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [-98.5, 39.5],
      zoom: 3.4,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      installRadar(map);

      map.addSource('alerts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'alerts-fill',
        type: 'fill',
        source: 'alerts',
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], '#9aa0a6'],
          'fill-opacity': 0.25,
        },
      });
      map.addLayer({
        id: 'alerts-line',
        type: 'line',
        source: 'alerts',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#9aa0a6'],
          'line-width': 1.5,
          'line-opacity': 0.9,
        },
      });

      map.on('click', 'alerts-fill', (e) => {
        const f = e.features && e.features[0];
        if (f) setSelected(f.properties || null);
      });
      map.on('mouseenter', 'alerts-fill', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'alerts-fill', () => {
        map.getCanvas().style.cursor = '';
      });
    });

    // The mosaic tile is user-resizable; without an explicit resize the
    // canvas keeps its mount-time dimensions and clips.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, [installRadar]);

  // First fetch + 5-minute refresh loop. Each tick re-pulls the alerts
  // and busts the radar tiles.
  useEffect(() => {
    fetchAlerts();
    const id = setInterval(() => {
      fetchAlerts();
      installRadar(mapRef.current);
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAlerts, installRadar]);

  // Push alert polygons onto the map whenever they change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const fc = data?.features || { type: 'FeatureCollection', features: [] };
    const apply = () => {
      const src = map.getSource('alerts');
      if (src) src.setData(fc);
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [data]);

  // Confab-safe AI brief: only ask when there's something to read.
  // Zero active warnings → skip the call and show a plain line; a dead
  // LLM degrades to the server's "Data unavailable." like every panel.
  useEffect(() => {
    if (!data) return undefined;
    const totalActive = (data.mappedCount || 0) + (data.areaOnlyCount || 0);
    if (totalActive === 0) {
      setBrief('');
      return undefined;
    }
    let cancelled = false;
    setBriefLoading(true);
    const lines = [];
    const counts = data.counts || {};
    const countLine = Object.entries(counts)
      .map(([ev, n]) => `${ev}: ${n}`)
      .join(', ');
    lines.push(`Active warnings drawn on map: ${data.mappedCount || 0}.`);
    if (countLine) lines.push(`By type: ${countLine}.`);
    if (data.areaOnlyCount) {
      lines.push(`Plus ${data.areaOnlyCount} area-based advisories without inline geometry.`);
    }
    lines.push('');
    lines.push('Most severe (severity · event · area · expires):');
    (data.list || []).slice(0, 12).forEach((a) => {
      lines.push(`  ${a.severity} · ${a.event} · ${a.areaDesc || '—'} · expires ${fmtExpires(a.expires)}`);
    });
    api
      .post('/terminal/annotate', { function: 'RDR', context: lines.join('\n') })
      .then(({ data: payload }) => {
        if (!cancelled) setBrief(payload.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  const onRefresh = () => {
    fetchAlerts();
    installRadar(mapRef.current);
  };

  const totalActive = data ? (data.mappedCount || 0) + (data.areaOnlyCount || 0) : null;

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">RDR</span>
        <span className="name">Weather Radar · live</span>
        <span style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
          updated {fmtClock(updatedAt)}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          title="Refresh radar + alerts"
          style={{
            background: 'transparent',
            color: 'var(--term-fg-dim)',
            border: '1px solid var(--term-border)',
            padding: '2px 8px',
            font: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
            letterSpacing: '0.06em',
          }}
        >
          ↻
        </button>
      </div>

      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 320, position: 'relative' }}
      >
        {/* Legend + area-only count + unavailable chip, over the map. */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 2,
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid var(--term-border)',
            padding: '6px 8px',
            fontSize: 10,
            color: 'var(--term-fg-dim)',
            maxWidth: 220,
            pointerEvents: 'none',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px' }}>
            {LEGEND.map(([label, color]) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 9, height: 9, background: color, display: 'inline-block' }} />
                {label}
              </span>
            ))}
          </div>
          {alertsErr ? (
            <div style={{ color: 'var(--term-negative)', marginTop: 4 }}>
              NWS alerts unavailable — radar only.
            </div>
          ) : data && data.areaOnlyCount > 0 ? (
            <div style={{ color: 'var(--term-fg-muted)', marginTop: 4 }}>
              +{data.areaOnlyCount} area-based advisories not drawn
            </div>
          ) : null}
        </div>

        {/* Clicked-alert detail card. */}
        {selected ? (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 3,
              width: 260,
              background: 'var(--term-bg-panel)',
              border: '1px solid var(--term-border)',
              padding: '8px 10px',
              fontSize: 11,
              color: 'var(--term-fg)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span
                style={{ width: 10, height: 10, background: selected.color || '#9aa0a6', display: 'inline-block' }}
              />
              <span style={{ color: 'var(--term-white)', fontWeight: 600 }}>{selected.event}</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--term-fg-dim)',
                  cursor: 'pointer',
                  font: 'inherit',
                }}
              >
                ×
              </button>
            </div>
            <div style={{ color: 'var(--term-fg-dim)', marginTop: 4 }}>{selected.severity}</div>
            {selected.areaDesc ? (
              <div style={{ marginTop: 4 }}>{selected.areaDesc}</div>
            ) : null}
            {selected.headline ? (
              <div style={{ color: 'var(--term-fg-muted)', marginTop: 4, lineHeight: 1.4 }}>
                {selected.headline}
              </div>
            ) : null}
            <div style={{ color: 'var(--term-fg-muted)', marginTop: 4 }}>
              expires {fmtExpires(selected.expires)}
            </div>
          </div>
        ) : null}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading
          ? 'Generating…'
          : totalActive === 0
          ? 'No active NWS warnings nationwide.'
          : brief || 'No brief available.'}
      </div>

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Radar: NEXRAD base reflectivity (Iowa Environmental Mesonet),
        refreshed ~5 min. Warnings: NWS active alerts (api.weather.gov).
        Storm-based warnings (tornado / severe TS / flash flood) draw as
        polygons; many county/zone advisories carry no inline shape and
        are counted, not drawn. Current conditions, not a forecast.
      </div>
    </div>
  );
}
