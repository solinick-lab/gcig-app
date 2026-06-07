import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { earningsHandler } from './terminal.js';

// Mirrors terminal.execbios.test.js / terminal.quotes.test.js exactly:
// the repo carries no route-test harness or supertest, so the express
// handler is a thin wrapper over the exported earningsHandler, driven
// directly with an injected service (deps.getEarnings) and a minimal
// fake req/res — never the network or Finnhub. Same precedent every
// existing suite follows.
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

// Happy path: a ticker whose injected service yields an upcoming row
// plus a trailing beat/miss history comes back as the
// { ticker, upcoming, history } shape the Earnings panel consumes.
// The ticker is upper-cased before it reaches the service.
test('GET /earnings/:ticker: 200 with { ticker, upcoming, history } when the service yields data', async () => {
  const res = fakeRes();
  await earningsHandler(
    { params: { ticker: 'aapl' } },
    res,
    {
      getEarnings: async (ticker) => {
        assert.equal(ticker, 'AAPL');
        return {
          upcoming: { date: '2026-07-30', epsEstimate: 1.42 },
          history: [
            { period: 'Q1 2026', date: '2026-01-30', epsEstimate: 2.35, epsActual: 2.4, surprisePct: 2.13 },
            { period: 'Q4 2025', date: '2025-10-31', epsEstimate: 1.6, epsActual: 1.64, surprisePct: 2.5 },
          ],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'AAPL');
  assert.deepEqual(res.body.upcoming, { date: '2026-07-30', epsEstimate: 1.42 });
  assert.equal(Array.isArray(res.body.history), true);
  assert.equal(res.body.history.length, 2);
  assert.deepEqual(res.body.history[0], {
    period: 'Q1 2026',
    date: '2026-01-30',
    epsEstimate: 2.35,
    epsActual: 2.4,
    surprisePct: 2.13,
  });
});

// The honest-empty tier (ETFs, illiquid names, no consensus coverage):
// the service returns { upcoming:null, history:[] }. That is a normal
// 200 with the same shape — the panel renders an honest "no earnings
// data" line and suppresses the AI brief, it does NOT 4xx/5xx.
test('GET /earnings/:ticker: 200 + empty shape on a coverage miss (never 4xx/5xx)', async () => {
  const res = fakeRes();
  await earningsHandler(
    { params: { ticker: 'SPY' } },
    res,
    { getEarnings: async () => ({ upcoming: null, history: [] }) }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'SPY');
  assert.equal(res.body.upcoming, null);
  assert.deepEqual(res.body.history, []);
});

// An invalid ticker is the one acceptable non-200 — it mirrors the
// sibling /governance/:ticker route's own input guard exactly
// (/^[A-Z0-9.\-]{1,12}$/ → 400 'Invalid ticker'). No service call.
test('GET /earnings/:ticker: 400 on an invalid ticker, like the sibling route', async () => {
  const res = fakeRes();
  let called = false;
  await earningsHandler(
    { params: { ticker: 'not a ticker!!' } },
    res,
    { getEarnings: async () => { called = true; return { upcoming: null, history: [] }; } }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(called, false, 'service must not be called for an invalid ticker');
});

// The service is contractually never-throws, but the handler must not
// assume that: if getEarnings (or anything in the handler) rejects, the
// handler catches and degrades to a 200 honest-empty stub with the same
// { ticker, upcoming:null, history:[] } shape. It must NEVER 5xx — the
// contract the route comment promises.
test('GET /earnings/:ticker: never 5xx even if the service rejects', async () => {
  const res = fakeRes();
  await earningsHandler(
    { params: { ticker: 'BOOM' } },
    res,
    {
      getEarnings: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'BOOM');
  assert.equal(res.body.upcoming, null);
  assert.deepEqual(res.body.history, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.execbios.test.js / quotes.test.js
// use: prove the new /earnings route sits on the same router stack,
// after the same three module-scope middlewares (verifyJwt →
// requireExecutiveOrAdvisory → aiLimiter), with no extra/different per-route
// middleware than the sibling. Both routes then provably traverse an
// identical auth chain.
test('earnings inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
  const layers = router.stack;

  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  const vIdx = globalMw.indexOf('verifyJwt');
  const eIdx = globalMw.indexOf('requireExecutiveOrAdvisory');
  assert.ok(vIdx >= 0, 'verifyJwt must be a global middleware on the terminal router');
  assert.ok(eIdx > vIdx, 'requireExecutiveOrAdvisory must follow verifyJwt globally');
  assert.ok(
    layers.filter((l) => !l.route).length >= 3,
    'expected verifyJwt + requireExecutiveOrAdvisory + aiLimiter as global middlewares'
  );

  const findRoute = (p) =>
    layers.find((l) => l.route && l.route.path === p);
  const sibling = findRoute('/governance/:ticker');
  const target = findRoute('/earnings/:ticker');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/earnings/:ticker route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'earnings must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
