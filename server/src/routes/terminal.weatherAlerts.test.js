import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { weatherAlertsHandler } from './terminal.js';

// Same precedent as terminal.weatherImpact.test.js: no supertest
// harness in the repo, so the thin express wrapper is exercised
// through the exported weatherAlertsHandler with an injected service
// (deps.getActiveAlerts) and a minimal fake req/res — never the
// network or the live NWS feed.
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Happy path: the handler passes the wxAlerts payload straight through
// — it owns no shaping of its own, the service already returns the
// client-ready envelope.
test('GET /wx-alerts: 200 passes the service payload through unchanged', async () => {
  const res = fakeRes();
  const payload = {
    asOf: '2026-05-20T00:00:00.000Z',
    total: 2,
    mappedCount: 1,
    areaOnlyCount: 1,
    counts: { 'Tornado Warning': 1 },
    features: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-97, 35], [-96, 35], [-96, 36], [-97, 35]]] },
          properties: { id: 'x', event: 'Tornado Warning', severity: 'Extreme', color: '#ff2d2d' },
        },
      ],
    },
    list: [{ id: 'x', event: 'Tornado Warning', severity: 'Extreme' }],
  };
  await weatherAlertsHandler({}, res, { getActiveAlerts: async () => payload });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.mappedCount, 1);
  assert.equal(res.body.features.features.length, 1);
  assert.equal(res.body.list[0].event, 'Tornado Warning');
});

// getActiveAlerts rejecting (past its never-throws contract) must NOT
// 5xx. The handler degrades to the honest-empty FeatureCollection so
// the panel still paints its radar with zero polygons.
test('GET /wx-alerts: never 5xx when getActiveAlerts rejects — degrades to empty shape', async () => {
  const res = fakeRes();
  await weatherAlertsHandler({}, res, {
    getActiveAlerts: async () => {
      throw new Error('unexpected: service contract violated');
    },
  });
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.mappedCount, 0);
  assert.deepEqual(res.body.counts, {});
  assert.deepEqual(res.body.features, { type: 'FeatureCollection', features: [] });
  assert.deepEqual(res.body.list, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route, the
// same technique the other terminal route suites use: prove /wx-alerts
// sits on the same router stack after the same global middlewares with
// no extra per-route auth/limiter.
test('wx-alerts inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
  const layers = router.stack;

  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  const vIdx = globalMw.indexOf('verifyJwt');
  const eIdx = globalMw.indexOf('requireExecutive');
  assert.ok(vIdx >= 0, 'verifyJwt must be a global middleware on the terminal router');
  assert.ok(eIdx > vIdx, 'requireExecutive must follow verifyJwt globally');

  const findRoute = (p) => layers.find((l) => l.route && l.route.path === p);
  const sibling = findRoute('/governance/:ticker');
  const target = findRoute('/wx-alerts');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/wx-alerts route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'wx-alerts must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
});
