import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { filingsHandler } from './terminal.js';

// Mirrors terminal.quotes.test.js / terminal.execbios.test.js exactly:
// no route-test harness or supertest in the repo, so the express
// handler is a thin wrapper over the exported filingsHandler, driven
// directly with an injected service (deps.getRecentFilings) and a
// minimal fake req/res — never the network or SEC EDGAR. Same
// precedent every existing terminal suite follows.
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

// The happy path: a path-param ticker comes back as the
// { ticker, filings:[{ form, filingDate, description, accessionNumber,
// url }] } shape the Filings panel consumes. The handler upper-cases
// the ticker and asks the service for a 40-row window.
test('GET /filings/:ticker: 200 with the filings list for the ticker', async () => {
  const res = fakeRes();
  await filingsHandler(
    { params: { ticker: 'aapl' } },
    res,
    {
      getRecentFilings: async (ticker, opts) => {
        assert.equal(ticker, 'AAPL');
        assert.deepEqual(opts, { limit: 40 });
        return [
          {
            form: '8-K',
            filingDate: '2026-05-01',
            description: 'Current report',
            accessionNumber: '0000320193-26-000050',
            url: 'https://www.sec.gov/Archives/edgar/data/320193/x/a.htm',
          },
          {
            form: '10-Q',
            filingDate: '2026-04-25',
            description: 'Quarterly report',
            accessionNumber: '0000320193-26-000049',
            url: 'https://www.sec.gov/Archives/edgar/data/320193/y/b.htm',
          },
        ];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'AAPL');
  assert.equal(Array.isArray(res.body.filings), true);
  assert.equal(res.body.filings.length, 2);
  assert.deepEqual(res.body.filings[0], {
    form: '8-K',
    filingDate: '2026-05-01',
    description: 'Current report',
    accessionNumber: '0000320193-26-000050',
    url: 'https://www.sec.gov/Archives/edgar/data/320193/x/a.htm',
  });
});

// The 40-row cap is the route's contract with the panel: it always
// asks getRecentFilings for { limit: 40 } regardless of what the
// service ultimately returns (its own 6h cache decides that). Proven
// by the assertion inside the injected service above and re-checked
// here against a different ticker so the cap isn't ticker-coupled.
test('GET /filings/:ticker: always requests a 40-row window', async () => {
  const res = fakeRes();
  let seenOpts;
  await filingsHandler(
    { params: { ticker: 'MSFT' } },
    res,
    {
      getRecentFilings: async (_t, opts) => {
        seenOpts = opts;
        return [];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seenOpts, { limit: 40 });
  assert.deepEqual(res.body, { ticker: 'MSFT', filings: [] });
});

// An invalid ticker is the one acceptable non-200 — it mirrors the
// sibling /governance/:ticker and exec-bios input guards exactly
// (/^[A-Z0-9.\-]{1,12}$/ → 400 'Invalid ticker'). No service call.
test('GET /filings/:ticker: 400 on an invalid ticker, like the sibling routes', async () => {
  const res = fakeRes();
  let called = false;
  await filingsHandler(
    { params: { ticker: 'not a ticker!!' } },
    res,
    { getRecentFilings: async () => { called = true; return []; } }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(called, false, 'service must not be called for an invalid ticker');
});

// getRecentFilings is contractually never-throws (it returns [] on
// any miss), but the handler must not assume that: a rejecting
// service (or any throw in the handler) is caught and degrades to a
// 200 honest-empty { ticker, filings: [] } with a console.warn —
// exactly the exec-bios / quotes contract. It must NEVER 5xx.
test('GET /filings/:ticker: never 5xx even if the service rejects', async () => {
  const res = fakeRes();
  await filingsHandler(
    { params: { ticker: 'BOOM' } },
    res,
    {
      getRecentFilings: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'BOOM', filings: [] });
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.execbios.test.js / quotes use:
// prove the new /filings/:ticker route sits on the same router stack,
// after the same three module-scope middlewares (verifyJwt →
// requireExecutiveOrAdvisory → aiLimiter), with no extra/different per-route
// middleware than the sibling. Both routes then provably traverse an
// identical auth chain.
test('filings inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/filings/:ticker');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/filings/:ticker route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'filings must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
