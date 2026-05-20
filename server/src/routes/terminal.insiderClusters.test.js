import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, { insiderClustersHandler } from './terminal.js';

// Mirrors terminal.filings.test.js / terminal.execbios.test.js exactly:
// no route-test harness or supertest in the repo, so the express
// handler is a thin wrapper over the exported insiderClustersHandler,
// driven directly with an injected service (deps.scanUniverse /
// deps.getSheetPortfolio / deps.getWatchlistTickers) and a minimal
// fake req/res. Never the network, never the Form 4 fetcher, never
// the price cache. Pure handler-level routing math.
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

// Happy path: the holdings sheet hands the route a small book, the
// scanner returns a ranked list, and the response shape is the
// { asOf, universe, results } the panel consumes. The universe is
// built from holdings only (cash excluded) when no watchlist provider
// is wired.
test('GET /insider-clusters: 200 with { asOf, universe, results } from holdings (no watchlist)', async () => {
  const res = fakeRes();
  let scannedWith;
  await insiderClustersHandler(
    { query: {} },
    res,
    {
      getSheetPortfolio: async () => ({
        holdings: [
          { ticker: 'AAPL', isCash: false },
          { ticker: 'MSFT', isCash: false },
          { ticker: 'CASH', isCash: true },
        ],
      }),
      scanUniverse: async (list) => {
        scannedWith = list;
        return [
          {
            ticker: 'AAPL',
            insiderCount: 4,
            totalDollars: 250000,
            score: 175000,
            intoWeakness: true,
            periodDays: 60,
            latestBuyAt: '2026-05-15',
            topInsider: 'Tim Cook',
          },
          {
            ticker: 'MSFT',
            insiderCount: 3,
            totalDollars: 90000,
            score: 54000,
            intoWeakness: false,
            periodDays: 60,
            latestBuyAt: '2026-05-12',
            topInsider: 'Satya Nadella',
          },
        ];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.body.asOf === 'string' && res.body.asOf.length > 0, 'asOf must be a non-empty ISO string');
  assert.deepEqual(scannedWith, ['AAPL', 'MSFT'], 'cash filtered, holdings only when no watchlist');
  assert.deepEqual(res.body.universe, ['AAPL', 'MSFT']);
  assert.equal(res.body.results.length, 2);
  assert.equal(res.body.results[0].ticker, 'AAPL');
  assert.equal(res.body.results[0].score, 175000);
});

// The ?tickers= override replaces the computed universe entirely —
// neither the holdings nor a wired watchlist contribute. List is
// normalized the same way /quotes does: split, trim, upper-case, drop
// empties, dedupe.
test('GET /insider-clusters: ?tickers=A,B,C overrides the computed universe', async () => {
  const res = fakeRes();
  let portfolioCalled = false;
  let watchlistCalled = false;
  let scannedWith;
  await insiderClustersHandler(
    { query: { tickers: 'aapl,msft,aapl,, googl ' } },
    res,
    {
      getSheetPortfolio: async () => {
        portfolioCalled = true;
        return { holdings: [{ ticker: 'NVDA', isCash: false }] };
      },
      getWatchlistTickers: async () => {
        watchlistCalled = true;
        return ['TSLA'];
      },
      scanUniverse: async (list) => {
        scannedWith = list;
        return [];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(portfolioCalled, false, '?tickers= must not read the holdings sheet');
  assert.equal(watchlistCalled, false, '?tickers= must not read the watchlist');
  assert.deepEqual(scannedWith, ['AAPL', 'MSFT', 'GOOGL']);
  assert.deepEqual(res.body.universe, ['AAPL', 'MSFT', 'GOOGL']);
  assert.deepEqual(res.body.results, []);
});

// Watchlist is loose-coupled: when a getWatchlistTickers dep is
// provided the route folds it into the universe alongside holdings.
// On this branch the route module doesn't yet exist, so the equivalent
// runtime path is "dep absent → holdings only" — verified by the first
// test. Here we verify "dep present → merged + deduped".
test('GET /insider-clusters: holdings + watchlist tickers merged and de-duped', async () => {
  const res = fakeRes();
  let scannedWith;
  await insiderClustersHandler(
    { query: {} },
    res,
    {
      getSheetPortfolio: async () => ({
        holdings: [
          { ticker: 'AAPL', isCash: false },
          { ticker: 'MSFT', isCash: false },
          { ticker: 'CASH', isCash: true },
        ],
      }),
      getWatchlistTickers: async () => ['MSFT', 'GOOGL'], // MSFT overlaps holdings
      scanUniverse: async (list) => {
        scannedWith = list;
        return [];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  // Order: holdings first, then watchlist additions, deduped.
  assert.deepEqual(scannedWith, ['AAPL', 'MSFT', 'GOOGL']);
  assert.deepEqual(res.body.universe, ['AAPL', 'MSFT', 'GOOGL']);
});

// Missing watchlist module: pre-merge of #32, the route on this
// branch must degrade honestly — no crash, no warn-spam, no 5xx, just
// "universe = holdings". The first happy-path test already covers the
// "no provider wired" runtime; this one asserts an explicit throw in
// the provider also degrades silently (so a swallowed ERR_MODULE_NOT_FOUND
// surfaces the same way).
test('GET /insider-clusters: a throwing watchlist provider is honestly degraded (no crash, holdings only)', async () => {
  const res = fakeRes();
  let scannedWith;
  const warn = console.warn;
  console.warn = () => {};
  try {
    await insiderClustersHandler(
      { query: {} },
      res,
      {
        getSheetPortfolio: async () => ({
          holdings: [{ ticker: 'AAPL', isCash: false }],
        }),
        getWatchlistTickers: async () => {
          throw new Error('module not found');
        },
        scanUniverse: async (list) => {
          scannedWith = list;
          return [];
        },
      }
    );
  } finally {
    console.warn = warn;
  }
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(scannedWith, ['AAPL']);
});

// scanUniverse is contractually never-throws, but the handler must
// not lean on that: an unexpected rejection still degrades to a 200
// honest-empty { asOf, universe:[], results:[] } with a console.warn.
// Never a 5xx — the contract every sibling promises.
test('GET /insider-clusters: never 5xx if scanUniverse rejects', async () => {
  const res = fakeRes();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await insiderClustersHandler(
      { query: {} },
      res,
      {
        getSheetPortfolio: async () => ({
          holdings: [{ ticker: 'AAPL', isCash: false }],
        }),
        scanUniverse: async () => {
          throw new Error('scan blew up');
        },
      }
    );
  } finally {
    console.warn = warn;
  }
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.universe, []);
  assert.deepEqual(res.body.results, []);
});

// A failing portfolio read is the second never-5xx path: the route
// can't build the universe, but it still answers honestly empty rather
// than erroring.
test('GET /insider-clusters: never 5xx if getSheetPortfolio rejects', async () => {
  const res = fakeRes();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await insiderClustersHandler(
      { query: {} },
      res,
      {
        getSheetPortfolio: async () => {
          throw new Error('sheet unavailable');
        },
        scanUniverse: async () => [],
      }
    );
  } finally {
    console.warn = warn;
  }
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.universe, []);
  assert.deepEqual(res.body.results, []);
});

// Defensive 50-ticker cap so a hand-crafted ?tickers= can't fan one
// request into a Finnhub burst. The on-screen universe is roughly
// 10–25 holdings + a small watchlist, so the cap is far above
// legitimate use.
test('GET /insider-clusters: caps the universe at 50 tickers', async () => {
  const res = fakeRes();
  // 60 unique tickers — should clip to 50.
  const tickers = Array.from({ length: 60 }, (_, i) => `T${i}`).join(',');
  let scannedWith;
  await insiderClustersHandler(
    { query: { tickers } },
    res,
    {
      getSheetPortfolio: async () => ({ holdings: [] }),
      scanUniverse: async (list) => {
        scannedWith = list;
        return [];
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(scannedWith.length, 50);
  assert.equal(res.body.universe.length, 50);
});

// Auth/limiter parity with the sibling /governance route, by the
// identical technique terminal.filings.test.js / execbios use: prove
// the new /insider-clusters route sits on the same router stack,
// after the same three module-scope middlewares (verifyJwt →
// requireExecutive → aiLimiter), with no extra/different per-route
// middleware than the sibling. Both routes then provably traverse an
// identical auth chain.
test('insider-clusters inherits the exact same global auth/limiter chain as /governance/:ticker', () => {
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
  const target = findRoute('/insider-clusters');
  assert.ok(sibling, 'sibling /governance/:ticker route must exist');
  assert.ok(target, '/insider-clusters route must be registered');

  const routeHandlerCount = (layer) =>
    layer.route.stack.filter((s) => s.method === 'get').length;
  assert.equal(
    routeHandlerCount(target),
    routeHandlerCount(sibling),
    'insider-clusters must carry the same number of GET handlers as the sibling (no extra per-route auth/limiter)'
  );
  assert.equal(
    routeHandlerCount(sibling),
    1,
    'sibling /governance/:ticker has exactly one handler — auth/limiter are global, not per-route'
  );
});
