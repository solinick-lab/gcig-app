import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { macroSensitivityHandler } from './terminal.js';

// terminal/macro-sensitivity — same colocated route-test shape every
// other terminal handler suite follows: no supertest in the repo, so
// the route handler is exercised directly with an injected service
// (deps.getMacroSensitivity) and a minimal fake req/res. Auth chain
// parity vs the sibling /governance/:ticker route proves the new
// endpoint inherits the same gate without any per-route middleware
// drift.

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

// Happy path: the service yields a fully populated panel object →
// the handler echoes it through as a 200 with the documented shape.
test('GET /macro-sensitivity: 200 with the full shape when the service yields data', async () => {
  const res = fakeRes();
  const fixture = {
    asOf: '2026-05-20T00:00:00.000Z',
    lookbackDays: 252,
    factors: [
      {
        id: 'DGS10',
        label: '10Y Yield',
        source: 'fred',
        kind: 'delta',
        unit: 'bps',
        defaultShock: 0.50,
        portfolioBeta: -1.4,
        scenario: { shock: 0.50, expectedMove: -0.70 },
        perTicker: [{ ticker: 'AAA', beta: -1.5, alpha: 0.001, rSquared: 0.12, n: 200, stdErr: 0.3, tStat: -5.0 }],
        surviving: ['AAA'],
        topContributors: [{ ticker: 'AAA', beta: -1.5, weight: 1.0, contribution: -1.5 }],
      },
    ],
    holdings: ['AAA'],
    marketValues: { AAA: 100_000 },
  };
  await macroSensitivityHandler({}, res, { getMacroSensitivity: async () => fixture });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.asOf, fixture.asOf);
  assert.equal(res.body.lookbackDays, 252);
  assert.equal(res.body.factors.length, 1);
  assert.equal(res.body.factors[0].id, 'DGS10');
  assert.deepEqual(res.body.holdings, ['AAA']);
  assert.deepEqual(res.body.marketValues, { AAA: 100_000 });
});

// The honest-empty tier: a service that rejects must still return 200
// with a documented empty shape (no factors, no holdings) — the panel
// renders a "FRED unavailable" message rather than a 5xx splash. The
// contract every terminal route shares.
test('GET /macro-sensitivity: 200 + honest empty when the service rejects (never 5xx)', async () => {
  const res = fakeRes();
  await macroSensitivityHandler(
    {},
    res,
    { getMacroSensitivity: async () => { throw new Error('FRED down'); } }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.lookbackDays, 252);
  assert.ok(Array.isArray(res.body.factors));
  assert.ok(Array.isArray(res.body.holdings));
  assert.equal(typeof res.body.marketValues, 'object');
});

// Auth/limiter parity vs the sibling /governance/:ticker route. The
// identical technique terminal.earnings.test.js / quotes.test.js use:
// prove the new /macro-sensitivity route sits on the same router
// stack, after the same three module-scope middlewares, with no extra
// per-route middleware than the sibling.
test('macro-sensitivity inherits the same global auth chain as /governance/:ticker', () => {
  const layers = router.stack;
  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  const vIdx = globalMw.indexOf('verifyJwt');
  const eIdx = globalMw.indexOf('requireExecutive');
  assert.ok(vIdx >= 0, 'verifyJwt must be a global middleware on the terminal router');
  assert.ok(eIdx > vIdx, 'requireExecutive must follow verifyJwt globally');
  assert.ok(
    layers.filter((l) => !l.route).length >= 3,
    'expected verifyJwt + requireExecutive + aiLimiter as global middlewares'
  );

  const findRoute = (p) =>
    layers.find((l) => l.route && l.route.path === p);
  const sibling = findRoute('/governance/:ticker');
  const target = findRoute('/macro-sensitivity');
  assert.ok(sibling, 'sibling /governance/:ticker must exist');
  assert.ok(target, '/macro-sensitivity route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'macro-sensitivity must carry the same number of GET handlers as the sibling'
  );
});
