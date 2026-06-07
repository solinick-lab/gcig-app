import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { consensusHandler } from './terminal.js';

// Mirrors terminal.earnings.test.js / terminal.filings.test.js exactly:
// the repo carries no route-test harness or supertest, so the express
// handler is a thin wrapper over the exported consensusHandler, driven
// directly with an injected service (deps.getConsensus) and a minimal
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

// Happy path: a ticker whose injected service yields the latest
// recommendation breakdown plus a recent newest-first trend comes back
// as the { ticker, latest, trend } shape the Consensus panel consumes.
// The ticker is upper-cased before it reaches the service.
test('GET /consensus/:ticker: 200 with { ticker, latest, trend } when the service yields data', async () => {
  const res = fakeRes();
  await consensusHandler(
    { params: { ticker: 'aapl' } },
    res,
    {
      getConsensus: async (ticker) => {
        assert.equal(ticker, 'AAPL');
        return {
          latest: { period: '2026-05-01', strongBuy: 12, buy: 18, hold: 6, sell: 2, strongSell: 1 },
          trend: [
            { period: '2026-05-01', strongBuy: 12, buy: 18, hold: 6, sell: 2, strongSell: 1 },
            { period: '2026-04-01', strongBuy: 10, buy: 17, hold: 8, sell: 3, strongSell: 1 },
          ],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'AAPL');
  assert.deepEqual(res.body.latest, {
    period: '2026-05-01',
    strongBuy: 12,
    buy: 18,
    hold: 6,
    sell: 2,
    strongSell: 1,
  });
  assert.equal(Array.isArray(res.body.trend), true);
  assert.equal(res.body.trend.length, 2);
  assert.deepEqual(res.body.trend[0], {
    period: '2026-05-01',
    strongBuy: 12,
    buy: 18,
    hold: 6,
    sell: 2,
    strongSell: 1,
  });
});

// The honest-empty tier (ETFs, illiquid names, no analyst coverage):
// the service returns { latest:null, trend:[] }. That is a normal 200
// with the same shape — the panel renders an honest "no analyst
// coverage" line and suppresses the AI brief, it does NOT 4xx/5xx.
test('GET /consensus/:ticker: 200 + empty shape on a coverage miss (never 4xx/5xx)', async () => {
  const res = fakeRes();
  await consensusHandler(
    { params: { ticker: 'SPY' } },
    res,
    { getConsensus: async () => ({ latest: null, trend: [] }) }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'SPY');
  assert.equal(res.body.latest, null);
  assert.deepEqual(res.body.trend, []);
});

// An invalid ticker is the one acceptable non-200 — it mirrors the
// sibling /governance/:ticker route's own input guard exactly
// (/^[A-Z0-9.\-]{1,12}$/ → 400 'Invalid ticker'). No service call.
test('GET /consensus/:ticker: 400 on an invalid ticker, like the sibling route', async () => {
  const res = fakeRes();
  let called = false;
  await consensusHandler(
    { params: { ticker: 'not a ticker!!' } },
    res,
    { getConsensus: async () => { called = true; return { latest: null, trend: [] }; } }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(called, false, 'service must not be called for an invalid ticker');
});

// The service is contractually never-throws, but the handler must not
// assume that: if getConsensus (or anything in the handler) rejects,
// the handler catches and degrades to a 200 honest-empty stub with the
// same { ticker, latest:null, trend:[] } shape. It must NEVER 5xx —
// the contract the route comment promises.
test('GET /consensus/:ticker: never 5xx even if the service rejects', async () => {
  const res = fakeRes();
  await consensusHandler(
    { params: { ticker: 'BOOM' } },
    res,
    {
      getConsensus: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'BOOM');
  assert.equal(res.body.latest, null);
  assert.deepEqual(res.body.trend, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.earnings.test.js / filings.test.js
// use: prove the new /consensus route sits on the same router stack,
// after the same three module-scope middlewares (verifyJwt →
// requireExecutiveOrAdvisory → aiLimiter), with no extra/different per-route
// middleware than the sibling. Both routes then provably traverse an
// identical auth chain.
test('consensus inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/consensus/:ticker');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/consensus/:ticker route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'consensus must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
