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

// What the live data tells us — vessels we receive cluster almost
// entirely in UAE waters (Abu Dhabi → Dubai → Sharjah → RAK →
// Fujairah). Public terrestrial AIS receivers are dense around those
// ports and effectively absent everywhere else in our bbox: zero
// public contributors in Iran, very sparse in Saudi / Kuwait / Iraq,
// limited in Bahrain / Qatar / most of Oman. So the honest map shows
// the entire Gulf shaded as out-of-reach with a hole punched over the
// UAE coastal strip where coverage actually exists. Polygon is a
// rectangle on purpose — receiver geography isn't publicly mapped, a
// tighter shape would imply false precision.
const COVERAGE_GAP_POLYGON = [
  // Outer ring: the full subscription bbox.
  [
    [47.5, 23.5],
    [57.5, 23.5],
    [57.5, 30.5],
    [47.5, 30.5],
    [47.5, 23.5],
  ],
  // Hole: UAE waters where receivers reach.
  [
    [54.0, 24.3],
    [54.0, 26.5],
    [57.0, 26.5],
    [57.0, 24.3],
    [54.0, 24.3],
  ],
];

// OpenFreeMap is a free, no-key, no-rate-limit, OSM-derived vector
// tile host. We use the "positron" light style — neutral background
// so the gold/navy vessel + terminal markers read clearly. Direct
// OSM raster tiles tend to fail under any real load (their public
// server has UA filtering and aggressive rate limits) and can leave
// the map blank in production.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export default function VesselMap({ snapshot, onVesselClick }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const dataRef = useRef({ vessels: [], terminals: [], bbox: null });
  const clickHandlerRef = useRef(onVesselClick);

  // Keep the click handler ref in sync without recreating the map.
  useEffect(() => { clickHandlerRef.current = onVesselClick; }, [onVesselClick]);

  // Initialize once.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: [52.5, 26.5],
      zoom: 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on('load', () => {
      // Cluster vessels so the Dubai-area pile-up — where 30+ vessels
      // sit within a few hundred metres of each other — reads as one
      // numbered circle instead of overlapping single dots that look
      // like the map only has 5 ships. Clustering disengages above
      // clusterMaxZoom so panned-in detail still shows individual
      // hulls.
      map.addSource('vessels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 11,
        clusterRadius: 35,
      });
      map.addSource('trails', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('terminals', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addSource('coverage-gap', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: COVERAGE_GAP_POLYGON },
          properties: {},
        },
      });

      // Drawn first so trails / vessels / terminals all sit above it.
      map.addLayer({
        id: 'coverage-gap-fill',
        type: 'fill',
        source: 'coverage-gap',
        paint: {
          'fill-color': '#1B2A4A',
          'fill-opacity': 0.08,
        },
      });
      map.addLayer({
        id: 'coverage-gap-outline',
        type: 'line',
        source: 'coverage-gap',
        paint: {
          'line-color': '#1B2A4A',
          'line-width': 1.2,
          'line-opacity': 0.5,
          'line-dasharray': [3, 3],
        },
      });

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

      // Cluster bubble — sized by how many vessels it represents.
      map.addLayer({
        id: 'vessel-clusters',
        type: 'circle',
        source: 'vessels',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#1B2A4A',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-radius': [
            'step', ['get', 'point_count'],
            14,           // <  10 vessels
            10, 18,       // 10-24
            25, 22,       // 25-49
            50, 26,       // 50+
          ],
        },
      });

      // Number inside the cluster bubble.
      map.addLayer({
        id: 'vessel-cluster-count',
        type: 'symbol',
        source: 'vessels',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 13,
          'text-allow-overlap': true,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // Individual unclustered vessel dot.
      map.addLayer({
        id: 'vessels-dot',
        type: 'circle',
        source: 'vessels',
        filter: ['!', ['has', 'point_count']],
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

      // Sentinel-1 SAR detections — hulls we picked up from satellite
      // radar imagery, often in waters AIS can't reach. Rendered as
      // small red diamonds beneath the live AIS dots so they fill in
      // the coverage gap rather than competing visually.
      map.addSource('sar', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'sar-dot',
        type: 'circle',
        source: 'sar',
        paint: {
          'circle-radius': [
            'case', ['get', 'tanker'], 4, 2.5,
          ],
          'circle-color': '#DC2626',
          'circle-opacity': 0.55,
          'circle-stroke-color': '#7F1D1D',
          'circle-stroke-width': [
            'case', ['get', 'tanker'], 1, 0,
          ],
        },
      }, 'vessels-dot'); // place below live AIS so AIS dots stay primary

      // Click a cluster → zoom in until the cluster expands.
      map.on('click', 'vessel-clusters', (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const clusterId = feat.properties.cluster_id;
        const src = map.getSource('vessels');
        if (!src) return;
        src.getClusterExpansionZoom(clusterId).then((zoom) => {
          map.easeTo({ center: feat.geometry.coordinates, zoom });
        });
      });
      map.on('mouseenter', 'vessel-clusters', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'vessel-clusters', () => { map.getCanvas().style.cursor = ''; });

      map.on('click', 'vessels-dot', (e) => {
        const feat = e.features && e.features[0];
        if (!feat) return;
        const props = feat.properties || {};
        const vessel = dataRef.current.vessels.find((v) => v.mmsi === Number(props.mmsi));
        if (vessel && clickHandlerRef.current) clickHandlerRef.current(vessel);
      });
      map.on('mouseenter', 'vessels-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'vessels-dot', () => { map.getCanvas().style.cursor = ''; });
    });

    return () => map.remove();
  }, []);

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

      const sarFeatures = (snapshot.sarDetections || []).map((d) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
        properties: {
          tanker: !!d.likelyTanker,
          length_m: d.lengthM,
        },
      }));

      const v = map.getSource('vessels');
      const tr = map.getSource('trails');
      const te = map.getSource('terminals');
      const sa = map.getSource('sar');
      if (v) v.setData({ type: 'FeatureCollection', features: vesselFeatures });
      if (tr) tr.setData({ type: 'FeatureCollection', features: trailFeatures });
      if (te) te.setData({ type: 'FeatureCollection', features: terminalFeatures });
      if (sa) sa.setData({ type: 'FeatureCollection', features: sarFeatures });
    };

    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [snapshot]);

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-[600px] w-full rounded-2xl border border-navy/10 shadow-sm"
      />
      <div className="pointer-events-none absolute bottom-3 left-3 max-w-[260px] rounded-lg border border-navy/10 bg-white/90 px-3 py-2 text-xs text-navy/70 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3 w-5 border border-dashed border-navy/50"
            style={{ backgroundColor: 'rgba(27,42,74,0.08)' }}
          />
          <span className="font-medium text-navy">Out of receiver reach</span>
        </div>
        <p className="mt-1 leading-snug">
          Free terrestrial AIS coverage is concentrated near UAE waters.
          Iran, Iraq, Kuwait, Saudi, Qatar, Bahrain, and most of Oman are
          out of reach without paid satellite AIS.
        </p>
      </div>
    </div>
  );
}
