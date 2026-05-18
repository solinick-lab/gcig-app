import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLiveQuotes,
  _resetLiveQuotes,
  QUOTE_TTL_MS,
} from './liveQuotes.js';

// A canned Finnhub /quote payload — the shape fetchFinnhub reads:
// c=current, d=change, dp=percent change, pc=previous close.
const quote = (c, dp, pc) => ({ c, d: c - pc, dp, pc });

test('maps Finnhub {c,dp,pc} to {last,changePct,prevClose} per ticker', async () => {
  _resetLiveQuotes();
  const seen = [];
  const quoteFetch = async (t) => {
    seen.push(t);
    return t === 'AAPL' ? quote(212.5, 1.25, 209.88) : quote(401.1, -0.4, 402.7);
  };
  const out = await getLiveQuotes(['AAPL', 'MSFT'], { quoteFetch });
  assert.deepEqual(out, {
    AAPL: { last: 212.5, changePct: 1.25, prevClose: 209.88 },
    MSFT: { last: 401.1, changePct: -0.4, prevClose: 402.7 },
  });
  assert.deepEqual(seen.sort(), ['AAPL', 'MSFT']);
});

test('upper-cases, de-dupes, and drops falsy / non-string entries', async () => {
  _resetLiveQuotes();
  let calls = 0;
  const quoteFetch = async () => {
    calls++;
    return quote(10, 0.5, 9.95);
  };
  const out = await getLiveQuotes(
    ['aapl', 'AAPL', null, '', 0, 42, {}, 'aapl'],
    { quoteFetch }
  );
  assert.deepEqual(out, { AAPL: { last: 10, changePct: 0.5, prevClose: 9.95 } });
  // One unique real ticker → exactly one upstream call.
  assert.equal(calls, 1);
});

test('per-ticker TTL: N calls within QUOTE_TTL_MS → one upstream call', async () => {
  _resetLiveQuotes();
  let calls = 0;
  let t = 1_000_000;
  const now = () => t;
  const quoteFetch = async () => {
    calls++;
    return quote(50, 2, 49);
  };
  // The first call stamps the cache `at` once; freshness is measured
  // against that fixed stamp (it does not slide on a hit — correct
  // insertion-TTL semantics). So total elapsed across all N calls must
  // stay strictly under QUOTE_TTL_MS for every one to be a cache hit.
  const step = Math.floor(QUOTE_TTL_MS / 10); // 10 calls < one TTL window
  for (let i = 0; i < 5; i++) {
    const out = await getLiveQuotes(['AAPL'], { quoteFetch, now });
    assert.deepEqual(out.AAPL, { last: 50, changePct: 2, prevClose: 49 });
    t += step;
  }
  assert.equal(calls, 1);
});

test('per-ticker TTL: a call after QUOTE_TTL_MS refetches', async () => {
  _resetLiveQuotes();
  let calls = 0;
  let t = 5_000;
  const now = () => t;
  const quoteFetch = async () => {
    calls++;
    return quote(100 + calls, 1, 99);
  };
  const first = await getLiveQuotes(['NVDA'], { quoteFetch, now });
  assert.equal(first.NVDA.last, 101);
  t += QUOTE_TTL_MS + 1; // step past the TTL
  const second = await getLiveQuotes(['NVDA'], { quoteFetch, now });
  assert.equal(second.NVDA.last, 102);
  assert.equal(calls, 2);
});

test('coalescing: concurrent cold requests share one upstream call', async () => {
  _resetLiveQuotes();
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const quoteFetch = async () => {
    calls++;
    await gate; // hold every in-flight fetch open until released
    return quote(900, 3, 870);
  };
  const a = getLiveQuotes(['NVDA'], { quoteFetch });
  const b = getLiveQuotes(['NVDA'], { quoteFetch });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra.NVDA, { last: 900, changePct: 3, prevClose: 870 });
  assert.deepEqual(rb.NVDA, ra.NVDA);
  assert.equal(calls, 1);
});

test('miss: empty / {c:0} / null payload → that ticker is null', async () => {
  _resetLiveQuotes();
  const out = await getLiveQuotes(['AAA', 'BBB', 'CCC'], {
    quoteFetch: async (t) => {
      if (t === 'AAA') return {};
      if (t === 'BBB') return { c: 0 };
      return null;
    },
  });
  assert.deepEqual(out, { AAA: null, BBB: null, CCC: null });
});

test('a null result is cached for the TTL (a bad symbol is not hammered)', async () => {
  _resetLiveQuotes();
  let calls = 0;
  let t = 0;
  const now = () => t;
  const quoteFetch = async () => {
    calls++;
    return { c: 0 };
  };
  await getLiveQuotes(['DEAD'], { quoteFetch, now });
  t += QUOTE_TTL_MS - 1;
  const again = await getLiveQuotes(['DEAD'], { quoteFetch, now });
  assert.equal(again.DEAD, null);
  assert.equal(calls, 1); // served the cached null, no second upstream hit
});

test('never throws: a throwing quoteFetch yields null, not a rejection', async () => {
  _resetLiveQuotes();
  const out = await getLiveQuotes(['AAPL', 'MSFT'], {
    quoteFetch: async (t) => {
      if (t === 'AAPL') throw new Error('finnhub 429');
      return quote(7, 0.1, 6.99);
    },
  });
  assert.equal(out.AAPL, null);
  assert.deepEqual(out.MSFT, { last: 7, changePct: 0.1, prevClose: 6.99 });
});

test('never throws: empty / null / non-array / string input → {} (no throw)', async () => {
  _resetLiveQuotes();
  const boom = async () => {
    throw new Error('should not be called');
  };
  assert.deepEqual(await getLiveQuotes([], { quoteFetch: boom }), {});
  assert.deepEqual(await getLiveQuotes(null, { quoteFetch: boom }), {});
  assert.deepEqual(await getLiveQuotes(undefined, { quoteFetch: boom }), {});
  // A bare string is not an array of tickers — treated as no input.
  assert.deepEqual(await getLiveQuotes('AAPL', { quoteFetch: boom }), {});
  // All entries falsy / non-string → no upstream call, empty result.
  assert.deepEqual(await getLiveQuotes([1, {}, '', null, false], { quoteFetch: boom }), {});
});

test('_resetLiveQuotes clears the cache so the next call refetches', async () => {
  _resetLiveQuotes();
  let calls = 0;
  const quoteFetch = async () => {
    calls++;
    return quote(33, 0, 33);
  };
  await getLiveQuotes(['AAPL'], { quoteFetch });
  await getLiveQuotes(['AAPL'], { quoteFetch }); // cache hit, no fetch
  assert.equal(calls, 1);
  _resetLiveQuotes();
  await getLiveQuotes(['AAPL'], { quoteFetch }); // cache cleared → refetch
  assert.equal(calls, 2);
});
