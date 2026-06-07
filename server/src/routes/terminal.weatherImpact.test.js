import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { weatherImpactHandler } from './terminal.js';

// Mirrors terminal.earnings.test.js / terminal.filings.test.js exactly:
// the repo carries no route-test harness or supertest, so the express
// handler is a thin wrapper over the exported weatherImpactHandler,
// driven directly with injected services (deps.getWeatherImpact /
// deps.getSheetPortfolio) and a minimal fake req/res — never the
// network, the sheet, or HURDAT2. Same precedent every existing suite
// follows.
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

// Happy path: the injected getSheetPortfolio yields the book (cash
// included; the handler filters cash out), the injected
// getWeatherImpact yields the assembled shape, and the response is the
// { asOf, activeStorms, exposures } envelope the panel consumes.
test('GET /weather-impact: 200 with { asOf, activeStorms, exposures } when both services yield data', async () => {
  const res = fakeRes();
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => ({
        holdings: [
          { ticker: 'XOM', isCash: false },
          { ticker: 'CASH', isCash: true },
          { ticker: 'TRV', isCash: false },
        ],
      }),
      getWeatherImpact: async (holdings) => {
        // Cash must have been stripped before reaching the service.
        assert.deepEqual(holdings, ['XOM', 'TRV']);
        return {
          asOf: '2026-05-20T00:00:00.000Z',
          activeStorms: [
            { name: 'Foo', classification: 'TS', intensity: 45, lastUpdate: '2026-05-19T12:00:00Z' },
          ],
          exposures: [
            {
              exposure: { id: 'gulf_oil_gas', label: 'Gulf O&G', tickers: ['XOM'], rationale: 'r' },
              holdingsOverlap: ['XOM'],
              study: { perWindow: { '1d': { mean: 0.01, median: 0.01, std: 0, n: 1, tStat: 0 }, '5d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 }, '20d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 } }, perEvent: [] },
            },
          ],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.asOf, '2026-05-20T00:00:00.000Z');
  assert.equal(Array.isArray(res.body.activeStorms), true);
  assert.equal(res.body.activeStorms.length, 1);
  assert.equal(Array.isArray(res.body.exposures), true);
  assert.equal(res.body.exposures.length, 1);
  assert.equal(res.body.exposures[0].exposure.id, 'gulf_oil_gas');
});

// getWeatherImpact rejecting (anything past the contract's never-throws
// promise) must NOT 5xx. The handler degrades to the honest-empty
// envelope: { activeStorms:[], exposures:[] } with an asOf timestamp so
// the panel can render "no data right now" without a fetch error.
test('GET /weather-impact: never 5xx when getWeatherImpact rejects — degrades to empty envelope', async () => {
  const res = fakeRes();
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => ({ holdings: [] }),
      getWeatherImpact: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.activeStorms, []);
  assert.deepEqual(res.body.exposures, []);
});

// getSheetPortfolio rejecting (the sheet is unreachable from Render
// briefly, the sheet ID is mis-set, etc.) must NOT 5xx either. The
// service is still called with an empty holdings list — the historical
// playbook stands without the holdings overlay.
test('GET /weather-impact: 200 when getSheetPortfolio rejects (holdings overlap empty, study still runs)', async () => {
  const res = fakeRes();
  let calledWith = null;
  await weatherImpactHandler(
    {},
    res,
    {
      getSheetPortfolio: async () => {
        throw new Error('sheet unreachable');
      },
      getWeatherImpact: async (holdings) => {
        calledWith = holdings;
        return {
          asOf: '2026-05-20T00:00:00.000Z',
          activeStorms: [],
          exposures: [],
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calledWith, [], 'an unreachable sheet still passes an empty list through');
  assert.deepEqual(res.body.activeStorms, []);
  assert.deepEqual(res.body.exposures, []);
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.earnings.test.js /
// terminal.filings.test.js use: prove the new /weather-impact route
// sits on the same router stack, after the same three module-scope
// middlewares (verifyJwt → requireExecutiveOrAdvisory → aiLimiter), with no
// extra/different per-route middleware than the sibling. Both routes
// then provably traverse an identical auth chain.
test('weather-impact inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/weather-impact');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/weather-impact route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'weather-impact must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
