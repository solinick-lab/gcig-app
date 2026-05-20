import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTickerCluster,
  scanUniverse,
  _resetInsiderClusters,
} from './insiderClusters.js';

// Service tests for the cluster scanner. Stays off the network: every
// case injects the Form-4 fetcher and the 90d-high lookup, the same
// shape insiderTx.test.js / executiveBios.test.js use. No DB. No
// Finnhub. No SEC. Pure analytic-layer math.

// Reusable normalized transaction the insiderTx fetcher emits (the
// shape the cluster service reads). `date` is ISO yyyy-mm-dd; `code`
// is the upper-cased single-letter Form 4 transaction code; `role` is
// the bucket string roleFromRelationship returns (officer title /
// "Director" / "10% Owner") or null when Finnhub didn't carry one.
function tx({ date, name, role, code, shares, price }) {
  return {
    date,
    name,
    role: role ?? null,
    code,
    isBuy: code === 'P',
    isSell: code === 'S',
    shares,
    price,
    value: shares != null && price ? shares * price : null,
  };
}

// Today is 2026-05-20 per the spec's clock. Anchor every fixture
// against a stable "today" so the 60d window math is reviewable.
const TODAY = new Date('2026-05-20T12:00:00Z');
const daysAgoIso = (n) => {
  const d = new Date(TODAY.getTime() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

// Hand-computed Σ(roleWeight × $) — kept tiny so the arithmetic is
// reviewable in the test source rather than reverse-engineered from a
// mocked Decimal library. 100 shares × $10 = $1,000 per leg, then
// the weight per role. Officer × $1,000 = 1,000; Director × $1,000 =
// 600; 10% Owner × $1,000 = 300. Sum = 1,900. totalDollars (unweighted)
// = 3,000.
const officer = tx({ date: daysAgoIso(5), name: 'Alice CEO', role: 'CEO', code: 'P', shares: 100, price: 10 });
const director = tx({ date: daysAgoIso(20), name: 'Bob Director', role: 'Director', code: 'P', shares: 100, price: 10 });
const tenPct = tx({ date: daysAgoIso(40), name: 'Carol Owner', role: '10% Owner', code: 'P', shares: 100, price: 10 });

test('getTickerCluster: three distinct insider purchases in 60d → cluster with exact counts/$/score', async () => {
  _resetInsiderClusters();
  const r = await getTickerCluster('AAPL', {
    getTransactions: async (sym) => {
      assert.equal(sym, 'AAPL');
      return [officer, director, tenPct];
    },
    get90dHigh: async () => 12, // most recent buy price (officer @ $10) < 12 × 0.9 = 10.8 → into-weakness
  });
  assert.ok(r, 'cluster must be returned');
  assert.equal(r.ticker, 'AAPL');
  assert.equal(r.insiderCount, 3);
  assert.equal(r.totalDollars, 3000);
  // Officer (1.0) × 1000 + Director (0.6) × 1000 + 10% Owner (0.3) × 1000
  // = 1000 + 600 + 300 = 1900.
  assert.equal(r.score, 1900);
  assert.equal(r.periodDays, 60);
  // Officer's most-recent buy (date 5 days ago) is the latest.
  assert.equal(r.latestBuyAt, officer.date);
  // Officer's role-weighted dollar sum is the largest → top insider.
  assert.equal(r.topInsider, 'Alice CEO');
  assert.equal(r.intoWeakness, true);
});

test('getTickerCluster: only two distinct insiders → null (threshold = 3)', async () => {
  _resetInsiderClusters();
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director],
    get90dHigh: async () => 100,
  });
  assert.equal(r, null);
});

test('getTickerCluster: non-P codes (S, M, G, A) excluded; only P counts toward score', async () => {
  _resetInsiderClusters();
  // Three distinct P purchases — the cluster threshold — plus a fat
  // pile of sells/exercises/grants on the same name. Score must reflect
  // only the P legs (1,900), never the noise.
  const noise = [
    tx({ date: daysAgoIso(3), name: 'Alice CEO', role: 'CEO', code: 'S', shares: 9999, price: 50 }),
    tx({ date: daysAgoIso(3), name: 'Alice CEO', role: 'CEO', code: 'M', shares: 9999, price: 50 }),
    tx({ date: daysAgoIso(3), name: 'Bob Director', role: 'Director', code: 'G', shares: 9999, price: 50 }),
    tx({ date: daysAgoIso(3), name: 'Carol Owner', role: '10% Owner', code: 'A', shares: 9999, price: 50 }),
  ];
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [...noise, officer, director, tenPct],
    get90dHigh: async () => 100,
  });
  assert.ok(r);
  assert.equal(r.insiderCount, 3, 'distinct count = P-only insiders');
  assert.equal(r.totalDollars, 3000, '$ sum = P legs only');
  assert.equal(r.score, 1900, 'score = P-only Σ(weight × $)');
});

test('getTickerCluster: 61d-old purchase excluded; the remaining 2 distinct insiders → null', async () => {
  _resetInsiderClusters();
  const old = tx({ date: daysAgoIso(61), name: 'Dan Old', role: 'CEO', code: 'P', shares: 100, price: 10 });
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director, old],
    get90dHigh: async () => 100,
  });
  assert.equal(r, null, '61d insider must not count → only 2 distinct → null');
});

test('getTickerCluster: role weights — Officer 1.0, Director 0.6, 10% Owner 0.3, unknown 0.2', async () => {
  _resetInsiderClusters();
  // 100 × $10 = $1,000 per leg. Sum: 1.0 + 0.6 + 0.3 + 0.2 = 2.1
  // × $1,000 = $2,100 — the hand-computed locked score.
  const unknown = tx({ date: daysAgoIso(10), name: 'Doug Unknown', role: null, code: 'P', shares: 100, price: 10 });
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director, tenPct, unknown],
    get90dHigh: async () => 100,
  });
  assert.ok(r);
  assert.equal(r.insiderCount, 4);
  assert.equal(r.totalDollars, 4000);
  assert.equal(r.score, 2100);
});

test('getTickerCluster: intoWeakness=true when most-recent buy ≤ 90d-high × 0.9', async () => {
  _resetInsiderClusters();
  // Most recent qualifying buy is officer @ $10; 90d high = $20.
  // $10 ≤ $20 × 0.9 = $18 → into-weakness.
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director, tenPct],
    get90dHigh: async () => 20,
  });
  assert.equal(r.intoWeakness, true);
});

test('getTickerCluster: intoWeakness=false when most-recent buy above the threshold', async () => {
  _resetInsiderClusters();
  // Most recent buy @ $10; 90d high = $10.5; threshold = 9.45. $10 > $9.45 → into-strength.
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director, tenPct],
    get90dHigh: async () => 10.5,
  });
  assert.equal(r.intoWeakness, false);
});

test('getTickerCluster: intoWeakness=null when no price data (honest unknown)', async () => {
  _resetInsiderClusters();
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [officer, director, tenPct],
    get90dHigh: async () => null,
  });
  assert.equal(r.intoWeakness, null, 'no price data → null, never silently false');
});

test('getTickerCluster: never throws — a throwing fetcher returns null', async () => {
  _resetInsiderClusters();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await getTickerCluster('AAPL', {
      getTransactions: async () => {
        throw new Error('finnhub down');
      },
      get90dHigh: async () => 100,
    });
    assert.equal(r, null);
  } finally {
    console.warn = warn;
  }
});

test('getTickerCluster: never throws — junk input returns null', async () => {
  _resetInsiderClusters();
  const r1 = await getTickerCluster('', {
    getTransactions: async () => [],
    get90dHigh: async () => 100,
  });
  assert.equal(r1, null);
  const r2 = await getTickerCluster(null, {
    getTransactions: async () => [],
    get90dHigh: async () => 100,
  });
  assert.equal(r2, null);
});

test('getTickerCluster: cache TTL — two calls within 6h hit upstream once; after reset → 2', async () => {
  _resetInsiderClusters();
  let calls = 0;
  const deps = {
    getTransactions: async () => {
      calls += 1;
      return [officer, director, tenPct];
    },
    get90dHigh: async () => 100,
  };
  await getTickerCluster('AAPL', deps);
  await getTickerCluster('AAPL', deps);
  assert.equal(calls, 1, 'second call inside the 6h window must be served from cache');
  _resetInsiderClusters();
  await getTickerCluster('AAPL', deps);
  assert.equal(calls, 2, 'after reset, the next call must refetch');
});

test('getTickerCluster: distinct insiders normalize case/whitespace', async () => {
  _resetInsiderClusters();
  // Same insider written three different ways must collapse to one.
  // The remaining two distinct names then fail the ≥3 threshold.
  const a1 = tx({ date: daysAgoIso(5), name: 'alice ceo', role: 'CEO', code: 'P', shares: 10, price: 1 });
  const a2 = tx({ date: daysAgoIso(7), name: ' ALICE CEO ', role: 'CEO', code: 'P', shares: 10, price: 1 });
  const a3 = tx({ date: daysAgoIso(9), name: 'Alice CEO', role: 'CEO', code: 'P', shares: 10, price: 1 });
  const b = tx({ date: daysAgoIso(11), name: 'Bob Director', role: 'Director', code: 'P', shares: 10, price: 1 });
  const r = await getTickerCluster('AAPL', {
    getTransactions: async () => [a1, a2, a3, b],
    get90dHigh: async () => 100,
  });
  assert.equal(r, null, 'three case-variant rows + one other = 2 distinct → below threshold');
});

test('scanUniverse: ranks results by score desc; nulls filtered out', async () => {
  _resetInsiderClusters();
  const deps = {
    getTransactions: async (sym) => {
      if (sym === 'HIGH') {
        return [officer, director, tenPct]; // score 1,900
      }
      if (sym === 'LOW') {
        // Three 10%-Owner P legs × $1,000 = score 900.
        return [
          tx({ date: daysAgoIso(2), name: 'Lo One', role: '10% Owner', code: 'P', shares: 100, price: 10 }),
          tx({ date: daysAgoIso(3), name: 'Lo Two', role: '10% Owner', code: 'P', shares: 100, price: 10 }),
          tx({ date: daysAgoIso(4), name: 'Lo Three', role: '10% Owner', code: 'P', shares: 100, price: 10 }),
        ];
      }
      if (sym === 'NONE') return []; // no cluster → filtered
      return [];
    },
    get90dHigh: async () => 100,
  };
  const ranked = await scanUniverse(['LOW', 'HIGH', 'NONE'], deps);
  assert.equal(ranked.length, 2, 'NONE must be filtered out');
  assert.equal(ranked[0].ticker, 'HIGH');
  assert.equal(ranked[0].score, 1900);
  assert.equal(ranked[1].ticker, 'LOW');
  assert.equal(ranked[1].score, 900);
});

test('scanUniverse: ties broken intoWeakness=true first, then latestBuyAt desc', async () => {
  _resetInsiderClusters();
  // Two same-score clusters. A is into-weakness, B is not. Ranked: A then B.
  const deps = {
    getTransactions: async (sym) => {
      if (sym === 'A' || sym === 'B') {
        return [officer, director, tenPct]; // both score 1,900
      }
      return [];
    },
    get90dHigh: async (sym) => (sym === 'A' ? 20 : 10.5),
  };
  const ranked = await scanUniverse(['B', 'A'], deps);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].ticker, 'A', 'into-weakness wins the tie');
  assert.equal(ranked[0].intoWeakness, true);
  assert.equal(ranked[1].ticker, 'B');
  assert.equal(ranked[1].intoWeakness, false);
});

test('scanUniverse: never throws on a rejecting per-ticker fetcher', async () => {
  _resetInsiderClusters();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ranked = await scanUniverse(['A', 'B'], {
      getTransactions: async () => {
        throw new Error('boom');
      },
      get90dHigh: async () => 100,
    });
    assert.deepEqual(ranked, []);
  } finally {
    console.warn = warn;
  }
});

test('scanUniverse: empty list returns []', async () => {
  _resetInsiderClusters();
  assert.deepEqual(await scanUniverse([], { getTransactions: async () => [], get90dHigh: async () => 100 }), []);
  assert.deepEqual(await scanUniverse(null, { getTransactions: async () => [], get90dHigh: async () => 100 }), []);
});
