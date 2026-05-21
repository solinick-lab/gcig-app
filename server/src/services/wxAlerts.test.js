import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveAlerts,
  colorForEvent,
  _resetWxAlerts,
} from './wxAlerts.js';

// A trimmed-down shape of what api.weather.gov/alerts/active returns:
// a GeoJSON FeatureCollection. Storm-based warnings (tornado, severe
// thunderstorm) carry inline polygons; zone/county advisories often
// arrive with geometry:null and are referenced by UGC code instead.
const POLY = {
  type: 'Polygon',
  coordinates: [[[-97, 35], [-96, 35], [-96, 36], [-97, 36], [-97, 35]]],
};

function fixture() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        id: 'urn:oid:2.49.0.1.840.0.tornado',
        type: 'Feature',
        geometry: POLY,
        properties: {
          event: 'Tornado Warning',
          severity: 'Extreme',
          headline: 'Tornado Warning issued May 20 for Cleveland County',
          areaDesc: 'Cleveland, OK',
          effective: '2026-05-20T20:00:00-05:00',
          expires: '2026-05-20T20:45:00-05:00',
        },
      },
      {
        id: 'urn:oid:2.49.0.1.840.0.svr',
        type: 'Feature',
        geometry: POLY,
        properties: {
          event: 'Severe Thunderstorm Warning',
          severity: 'Severe',
          headline: 'Severe Thunderstorm Warning for Sedgwick County',
          areaDesc: 'Sedgwick, KS',
          effective: '2026-05-20T19:30:00-05:00',
          expires: '2026-05-20T20:15:00-05:00',
        },
      },
      {
        // Zone-based advisory — no inline geometry. Counted in total
        // and areaOnlyCount, but not drawn on the map.
        id: 'urn:oid:2.49.0.1.840.0.winter',
        type: 'Feature',
        geometry: null,
        properties: {
          event: 'Winter Weather Advisory',
          severity: 'Minor',
          headline: 'Winter Weather Advisory for the Front Range',
          areaDesc: 'Larimer, CO',
          effective: '2026-05-20T18:00:00-07:00',
          expires: '2026-05-21T06:00:00-07:00',
        },
      },
    ],
  };
}

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

test('getActiveAlerts: splits mapped (polygon) from area-only (null geom)', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({ fetch: okFetch(fixture()) });
  assert.equal(data.total, 3);
  assert.equal(data.mappedCount, 2);
  assert.equal(data.areaOnlyCount, 1);
  assert.equal(data.features.type, 'FeatureCollection');
  assert.equal(data.features.features.length, 2);
});

test('getActiveAlerts: per-event counts cover mapped alerts only', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({ fetch: okFetch(fixture()) });
  assert.equal(data.counts['Tornado Warning'], 1);
  assert.equal(data.counts['Severe Thunderstorm Warning'], 1);
  // The winter advisory is area-only, so it is not in the mapped counts.
  assert.equal(data.counts['Winter Weather Advisory'], undefined);
});

test('getActiveAlerts: mapped feature properties are normalized + colored', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({ fetch: okFetch(fixture()) });
  const tornado = data.features.features.find(
    (f) => f.properties.event === 'Tornado Warning'
  );
  assert.ok(tornado, 'tornado feature present');
  assert.equal(tornado.properties.color, '#ff2d2d');
  assert.equal(tornado.properties.severity, 'Extreme');
  assert.equal(tornado.properties.areaDesc, 'Cleveland, OK');
  assert.equal(tornado.properties.id, 'urn:oid:2.49.0.1.840.0.tornado');
  assert.equal(tornado.properties.expires, '2026-05-20T20:45:00-05:00');
  // Geometry is preserved for the map.
  assert.equal(tornado.geometry.type, 'Polygon');
});

test('getActiveAlerts: list is mapped-only, geometry stripped, severity-sorted', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({ fetch: okFetch(fixture()) });
  assert.equal(data.list.length, 2);
  // Extreme (tornado) sorts ahead of Severe (thunderstorm).
  assert.equal(data.list[0].event, 'Tornado Warning');
  assert.equal(data.list[1].event, 'Severe Thunderstorm Warning');
  assert.equal(data.list[0].geometry, undefined);
});

test('colorForEvent: maps representative events, gray default', () => {
  assert.equal(colorForEvent('Tornado Warning'), '#ff2d2d');
  assert.equal(colorForEvent('Severe Thunderstorm Warning'), '#ff8c00');
  assert.equal(colorForEvent('Flash Flood Warning'), '#2ecc71');
  assert.equal(colorForEvent('Coastal Flood Advisory'), '#2ecc71');
  assert.equal(colorForEvent('Hurricane Warning'), '#ff5fa2');
  assert.equal(colorForEvent('Tropical Storm Watch'), '#ff5fa2');
  assert.equal(colorForEvent('Winter Storm Warning'), '#4aa3ff');
  assert.equal(colorForEvent('Blizzard Warning'), '#4aa3ff');
  assert.equal(colorForEvent('Excessive Heat Warning'), '#ffd23f');
  assert.equal(colorForEvent('Red Flag Warning'), '#ffd23f');
  assert.equal(colorForEvent('Air Quality Alert'), '#9aa0a6');
  assert.equal(colorForEvent(''), '#9aa0a6');
  assert.equal(colorForEvent(null), '#9aa0a6');
});

test('getActiveAlerts: never throws on a rejected fetch → empty shape', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({
    fetch: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(data.total, 0);
  assert.equal(data.mappedCount, 0);
  assert.equal(data.areaOnlyCount, 0);
  assert.deepEqual(data.counts, {});
  assert.deepEqual(data.features, { type: 'FeatureCollection', features: [] });
  assert.deepEqual(data.list, []);
});

test('getActiveAlerts: never throws on a non-ok response → empty shape', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  assert.equal(data.total, 0);
  assert.deepEqual(data.features.features, []);
});

test('getActiveAlerts: never throws on malformed JSON → empty shape', async () => {
  _resetWxAlerts();
  const data = await getActiveAlerts({
    fetch: okFetch({ notAFeatureCollection: true }),
  });
  assert.equal(data.total, 0);
  assert.deepEqual(data.list, []);
});

test('getActiveAlerts: caches within the TTL (one upstream call)', async () => {
  _resetWxAlerts();
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => fixture() };
  };
  await getActiveAlerts({ fetch: counting });
  await getActiveAlerts({ fetch: counting });
  assert.equal(calls, 1);
});
