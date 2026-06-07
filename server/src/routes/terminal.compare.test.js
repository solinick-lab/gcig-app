import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { compareHandler } from './terminal.js';

// Mirrors terminal.consensus.test.js / terminal.quotes.test.js exactly:
// the repo carries no route-test harness or supertest, so the express
// handler is a thin wrapper over the exported compareHandler, driven
// directly with an injected service (deps.getPeerSnapshot) and a
// minimal fake req/res — never the network or Finnhub. Same precedent
// every existing suite follows. CMP reuses getPeerSnapshot per ticker
// (the same fundamentals bundle Peers consumes), so the injected stub
// stands in for one snapshot fetch per requested symbol.
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

// Happy path: a comma list of tickers comes back as the
// { tickers, rows } shape the Compare panel consumes — one row per
// requested ticker, in request order, each carrying the comparison
// columns lifted from that ticker's snapshot. The list is upper-cased
// before it reaches the service.
test('GET /compare: 200 with { tickers, rows } — one normalized row per requested ticker', async () => {
  const res = fakeRes();
  const seen = [];
  await compareHandler(
    { query: { tickers: 'aapl,msft' } },
    res,
    {
      getPeerSnapshot: async (t) => {
        seen.push(t);
        if (t === 'AAPL') {
          return {
            ticker: 'AAPL',
            name: 'Apple Inc',
            price: 187.4,
            changePct: 0.0123,
            marketCap: 2.9e12,
            trailingPE: 31.2,
            forwardPE: 28.4,
            dividendYield: 0.005,
            beta: 1.21,
          };
        }
        return {
          ticker: 'MSFT',
          name: 'Microsoft Corp',
          price: 412.1,
          changePct: -0.004,
          marketCap: 3.1e12,
          trailingPE: 36.0,
          forwardPE: 31.7,
          dividendYield: 0.007,
          beta: 0.93,
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, ['AAPL', 'MSFT'], 'service is called per ticker, upper-cased');
  assert.deepEqual(res.body.tickers, ['AAPL', 'MSFT']);
  assert.equal(Array.isArray(res.body.rows), true);
  assert.equal(res.body.rows.length, 2);
  assert.deepEqual(res.body.rows[0], {
    ticker: 'AAPL',
    name: 'Apple Inc',
    marketCap: 2.9e12,
    peRatio: 31.2,
    forwardPE: 28.4,
    dividendYield: 0.005,
    beta: 1.21,
  });
  assert.deepEqual(res.body.rows[1], {
    ticker: 'MSFT',
    name: 'Microsoft Corp',
    marketCap: 3.1e12,
    peRatio: 36.0,
    forwardPE: 31.7,
    dividendYield: 0.007,
    beta: 0.93,
  });
});

// List normalization mirrors quotesHandler exactly — trim, upper-case,
// drop empties, dedupe — and CMP additionally caps the set at 4 (the
// panel never compares more than four). A junk-padded over-long list
// collapses to four distinct upper-cased symbols, and the service is
// called exactly that many times.
test('GET /compare: trims/uppercases/dedupes and caps the set at 4', async () => {
  const res = fakeRes();
  let calls = 0;
  await compareHandler(
    { query: { tickers: ' aapl , aapl, msft ,, nvda,googl,amzn,tsla ' } },
    res,
    {
      getPeerSnapshot: async (t) => {
        calls += 1;
        return {
          ticker: t,
          name: `${t} Inc`,
          price: 100,
          changePct: 0.01,
          marketCap: 1e11,
          trailingPE: 20,
          forwardPE: 18,
          dividendYield: 0.01,
          beta: 1,
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    res.body.tickers,
    ['AAPL', 'MSFT', 'NVDA', 'GOOGL'],
    'deduped, upper-cased, empties dropped, capped at the first 4'
  );
  assert.equal(res.body.rows.length, 4);
  assert.equal(calls, 4, 'service called once per capped ticker, no more');
});

// A snapshot miss (unknown symbol, Finnhub gap) is an honest
// null-field row, NOT a dropped ticker — the panel still renders a
// column for every name the user asked for, just with "—" cells.
// getPeerSnapshot returns null on a miss; that ticker keeps its row
// with every fundamental nulled.
test('GET /compare: a snapshot miss keeps the row with null fields (no dropped tickers)', async () => {
  const res = fakeRes();
  await compareHandler(
    { query: { tickers: 'AAPL,ZZZZ' } },
    res,
    {
      getPeerSnapshot: async (t) =>
        t === 'AAPL'
          ? {
              ticker: 'AAPL',
              name: 'Apple Inc',
              price: 187.4,
              changePct: 0.0123,
              marketCap: 2.9e12,
              trailingPE: 31.2,
              forwardPE: 28.4,
              dividendYield: 0.005,
              beta: 1.21,
            }
          : null,
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.tickers, ['AAPL', 'ZZZZ']);
  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.rows[0].ticker, 'AAPL');
  assert.equal(res.body.rows[0].name, 'Apple Inc');
  assert.deepEqual(res.body.rows[1], {
    ticker: 'ZZZZ',
    name: null,
    marketCap: null,
    peRatio: null,
    forwardPE: null,
    dividendYield: null,
    beta: null,
  });
});

// An empty / whitespace-only list is not an error — like quotesHandler
// (free-form list, not a path param), the lenient honest answer is a
// 200 with empty { tickers:[], rows:[] }, and the service is never
// called.
test('GET /compare: 200 honest-empty on an empty list, service not called', async () => {
  const res = fakeRes();
  let called = false;
  await compareHandler(
    { query: { tickers: '  , ,, ' } },
    res,
    { getPeerSnapshot: async () => { called = true; return null; } }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tickers: [], rows: [] });
  assert.equal(called, false, 'service must not be called for an empty list');
});

// The service is contractually never-throws, but the handler must not
// assume that: if getPeerSnapshot rejects for a symbol, that symbol
// degrades to a null-field row rather than sinking the whole response —
// the other tickers still resolve and the call is still a 200.
test('GET /compare: a per-ticker service rejection degrades that row, not the response', async () => {
  const res = fakeRes();
  await compareHandler(
    { query: { tickers: 'AAPL,BOOM' } },
    res,
    {
      getPeerSnapshot: async (t) => {
        if (t === 'BOOM') throw new Error('unexpected: service contract violated');
        return {
          ticker: 'AAPL',
          name: 'Apple Inc',
          price: 187.4,
          changePct: 0.0123,
          marketCap: 2.9e12,
          trailingPE: 31.2,
          forwardPE: 28.4,
          dividendYield: 0.005,
          beta: 1.21,
        };
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.tickers, ['AAPL', 'BOOM']);
  assert.equal(res.body.rows.length, 2);
  assert.equal(res.body.rows[0].ticker, 'AAPL');
  assert.deepEqual(res.body.rows[1], {
    ticker: 'BOOM',
    name: null,
    marketCap: null,
    peRatio: null,
    forwardPE: null,
    dividendYield: null,
    beta: null,
  });
});

// Even a total failure (something in the handler itself throws, not
// just a per-ticker snapshot) must never 5xx — the contract the route
// comment promises. The handler catches and degrades to the same
// honest-empty 200 { tickers:[], rows:[] } stub.
test('GET /compare: never 5xx — a total failure degrades to honest-empty', async () => {
  const res = fakeRes();
  await compareHandler(
    { query: { tickers: 'AAPL,MSFT' } },
    res,
    {
      getPeerSnapshot: () => {
        // Throws synchronously, before returning a promise — exercises
        // the handler-level catch, not the per-ticker .catch.
        throw new Error('catastrophic');
      },
    }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tickers: [], rows: [] });
});

// Auth/limiter parity with the sibling /governance/:ticker route, by
// the identical technique terminal.consensus.test.js / quotes.test.js
// use: prove the new /compare route sits on the same router stack,
// after the same three module-scope middlewares (verifyJwt →
// requireExecutiveOrAdvisory → aiLimiter), with no extra/different per-route
// middleware than the sibling. Both routes then provably traverse an
// identical auth chain.
test('compare inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/compare');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/compare route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'compare must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
