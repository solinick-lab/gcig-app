import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { quotesHandler } from './terminal.js';

// Mirrors terminal.execbios.test.js exactly: no route-test harness or
// supertest in the repo, so the express handler is a thin wrapper over
// the exported quotesHandler, driven directly with an injected service
// (deps.getLiveQuotes) and a minimal fake req/res — never the network
// or Finnhub. Same precedent every existing suite follows.
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

// The happy path: a comma-separated ?tickers list comes back as the
// { [TICKER]: {last,changePct,prevClose} | null } map the service
// yields — the exact shape useLiveRefresh-backed panels consume. A
// miss is an honest per-ticker null, not an error.
test('GET /quotes: 200 with the quote map for the requested tickers', async () => {
  const res = fakeRes();
  await quotesHandler(
    { query: { tickers: 'AAPL,MSFT' } },
    res,
    {
      getLiveQuotes: async (list) => {
        assert.deepEqual(list, ['AAPL', 'MSFT']);
        return {
          AAPL: { last: 187.4, changePct: 1.23, prevClose: 185.12 },
          MSFT: null,
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    AAPL: { last: 187.4, changePct: 1.23, prevClose: 185.12 },
    MSFT: null,
  });
});

// The route is the abuse net (the service deliberately does not cap):
// it upper-cases, trims, de-dupes, drops empty entries, and caps the
// list at 40 — extras are silently dropped, never an error. The handler
// must hand the service exactly that normalized, capped list.
test('GET /quotes: uppercases, trims, de-dupes, drops empties, caps at 40', async () => {
  const res = fakeRes();
  // 45 distinct symbols plus dupes/blanks/whitespace/lowercase noise.
  const many = Array.from({ length: 45 }, (_, i) => `SYM${i}`);
  const param =
    ['  aapl ', 'AAPL', 'msft', '', '   ', 'aapl', ...many].join(',');
  let received;
  await quotesHandler(
    { query: { tickers: param } },
    res,
    {
      getLiveQuotes: async (list) => {
        received = list;
        return Object.fromEntries(list.map((t) => [t, null]));
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(received.length, 40, 'list must be capped at 40');
  // First three after dedupe/upper/trim are AAPL, MSFT, SYM0…; no
  // blanks, all upper, no duplicate AAPL.
  assert.equal(received[0], 'AAPL');
  assert.equal(received[1], 'MSFT');
  assert.equal(
    received.filter((t) => t === 'AAPL').length,
    1,
    'AAPL must be de-duped to a single entry'
  );
  assert.ok(
    received.every((t) => t === t.trim() && t === t.toUpperCase() && t),
    'every entry must be trimmed, upper-cased, non-empty'
  );
});

// Missing / empty / all-whitespace tickers is NOT a 4xx. The sibling
// governance routes only 400 on a *malformed* path param; this route
// takes a free-form list and the service itself degrades empty/junk
// input to {} — so a simply-empty list is a lenient, never-5xx 200 {},
// matching the never-throws sibling convention (exec-bios returns an
// honest-empty 200, it does not error). The service is not called.
test('GET /quotes: missing/empty tickers → 200 {} (lenient, never 4xx), no service call', async () => {
  for (const q of [{}, { tickers: '' }, { tickers: '   ' }, { tickers: ',,' }]) {
    const res = fakeRes();
    let called = false;
    await quotesHandler(
      { query: q },
      res,
      { getLiveQuotes: async () => { called = true; return { X: null }; } }
    );
    assert.equal(res.statusCode, 200, `query ${JSON.stringify(q)} must be 200`);
    assert.deepEqual(res.body, {}, `query ${JSON.stringify(q)} must yield {}`);
    assert.equal(called, false, 'service must not be called for an empty list');
  }
});

// The service is contractually never-throws, but the handler must not
// assume that: a rejecting getLiveQuotes (or any throw in the handler)
// is caught and degrades to a 200 honest-empty {} with a console.warn —
// exactly the exec-bios contract. It must NEVER 5xx.
test('GET /quotes: never 5xx even if the service rejects', async () => {
  const res = fakeRes();
  await quotesHandler(
    { query: { tickers: 'AAPL,MSFT' } },
    res,
    {
      getLiveQuotes: async () => {
        throw new Error('unexpected: service contract violated');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {});
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.execbios.test.js uses: prove the
// new /quotes route sits on the same router stack, after the same three
// module-scope middlewares (verifyJwt → requireExecutive → aiLimiter),
// with no extra/different per-route middleware than the sibling. Both
// routes then provably traverse an identical auth chain.
test('quotes inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/quotes');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/quotes route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'quotes must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
