import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEventStudy } from './eventStudy.js';

// The math under the WX (and the next sub-project's) event-study panels.
// Every number asserted below was computed by hand from the injected
// bar series — these are the load-bearing assertions for the primitive,
// not a coverage stamp. If they drift, every panel built on top of this
// drifts with them.
//
// The handler shape is deliberately tiny: feed it events + a basket
// of tickers + an injected getHistory, and get back an aggregate per
// window plus a per-event detail list. Forward returns are SPY-relative
// (sector-neutral) and anchored independently on the ticker's own bar
// series and SPY's own bar series — non-trading-day skews on either
// side don't break alignment, they just skip the observation.

// Build a synthetic bar series of N consecutive trading days with
// hand-pinned closes. Skipping a calendar day inside the run mimics a
// holiday/weekend gap so the trading-day anchoring is exercised.
function bars(startDate, closes, { skipIndices = [] } = {}) {
  // startDate is a real ISO YYYY-MM-DD; we just walk it forward one
  // calendar day per bar, skipping any indices the caller marks. The
  // skip is symbolic: the test is about bar-index arithmetic, not
  // about the NYSE calendar.
  const out = [];
  const [y, m, d] = startDate.split('-').map(Number);
  let dt = new Date(Date.UTC(y, m - 1, d));
  let i = 0;
  let put = 0;
  while (put < closes.length) {
    if (!skipIndices.includes(i)) {
      out.push({
        date: dt.toISOString().slice(0, 10),
        close: closes[put],
        high: closes[put],
        low: closes[put],
        open: closes[put],
        volume: 1000,
      });
      put += 1;
    }
    dt = new Date(dt.getTime() + 86_400_000);
    i += 1;
  }
  return out;
}

// Single event × single ticker × single window — the cleanest possible
// hand-computation. Ticker rises 100 → 105 over five trading days
// (+5.0%), SPY rises 100 → 102 over the same five trading days
// (+2.0%), so the abnormal return is +3.0%. n=1 means std=0, t=0.
test('runEventStudy: single event / single ticker / 5d window — hand-computed abnormal = +3.00%', async () => {
  const xomBars = bars('2024-09-23', [100, 101, 102, 103, 104, 105]);
  const spyBars = bars('2024-09-23', [100, 100.5, 101, 101.5, 101.7, 102]);
  const fakeGetHistory = async (t) => {
    if (t === 'XOM') return xomBars;
    if (t === 'SPY') return spyBars;
    return [];
  };
  const out = await runEventStudy(
    [{ date: '2024-09-23', label: 'Helene' }],
    ['XOM'],
    { getHistory: fakeGetHistory }
  );
  const five = out.perWindow['5d'];
  assert.equal(five.n, 1);
  assert.ok(Math.abs(five.mean - 0.03) < 1e-9, `mean=${five.mean}, expected 0.03`);
  assert.ok(Math.abs(five.median - 0.03) < 1e-9, `median=${five.median}`);
  assert.equal(five.std, 0);
  assert.equal(five.tStat, 0);
  // Only the 1d and 5d perEvent rows survive — the 6-bar series can't
  // satisfy a 20d window, so that observation is skipped (the expected
  // n=0 on perWindow['20d'] is the same surface, just aggregated).
  assert.equal(out.perEvent.length, 2, '1d + 5d observations; 20d falls past tail');
  assert.equal(out.perWindow['20d'].n, 0);
  // The 5d perEvent row carries the same abnormal we just asserted.
  const e5 = out.perEvent.find((p) => p.window === 5);
  assert.equal(e5.ticker, 'XOM');
  assert.equal(e5.label, 'Helene');
  assert.ok(Math.abs(e5.abnormal - 0.03) < 1e-9);
});

// Three events × one ticker × one window, hand-set abnormals
// [+0.05, -0.02, +0.01]. Mean = 0.04/3 ≈ 0.0133333…, median (middle of
// sorted [-0.02, 0.01, 0.05]) = 0.01. Sample std (n-1):
//   deviations from mean: 0.05-0.01333=0.03667, -0.02-0.01333=-0.03333,
//   0.01-0.01333=-0.00333. squares: 0.001345, 0.001111, 1.111e-5;
//   sum ≈ 0.002467; /(n-1)=2 ≈ 0.0012335; sqrt ≈ 0.0351188.
//   t = mean / (std/sqrt(n)) = 0.01333 / (0.03512/sqrt(3))
//       = 0.01333 / 0.02028 ≈ 0.6575.
test('runEventStudy: 3 events × 1 ticker × 5d — mean=0.01333, median=0.01, std≈0.03512, t≈0.658', async () => {
  // Three event dates that each anchor to bar index 0 in a freshly-
  // constructed pair of series, with the exact close ratios needed
  // to land on the target abnormals.
  // Event 1: ticker +0.07, SPY +0.02 → abnormal +0.05.
  // Event 2: ticker +0.00, SPY +0.02 → abnormal -0.02.
  // Event 3: ticker +0.03, SPY +0.02 → abnormal +0.01.
  const ev1XomBars = bars('2024-01-02', [100, 100, 100, 100, 100, 107]);
  const ev1SpyBars = bars('2024-01-02', [100, 100, 100, 100, 100, 102]);
  const ev2XomBars = bars('2024-06-03', [200, 200, 200, 200, 200, 200]);
  const ev2SpyBars = bars('2024-06-03', [200, 200, 200, 200, 200, 204]);
  const ev3XomBars = bars('2024-09-09', [50, 50, 50, 50, 50, 51.5]);
  const ev3SpyBars = bars('2024-09-09', [50, 50, 50, 50, 50, 51]);

  // The injected getHistory must return *one* bar series per ticker
  // covering all three events. Stitch them in time order — each event
  // starts on its own date and there's no overlap, so a single
  // chronological list is enough.
  const xomBars = [...ev1XomBars, ...ev2XomBars, ...ev3XomBars];
  const spyBars = [...ev1SpyBars, ...ev2SpyBars, ...ev3SpyBars];
  const fakeGetHistory = async (t) => {
    if (t === 'XOM') return xomBars;
    if (t === 'SPY') return spyBars;
    return [];
  };
  const out = await runEventStudy(
    [
      { date: '2024-01-02', label: 'A' },
      { date: '2024-06-03', label: 'B' },
      { date: '2024-09-09', label: 'C' },
    ],
    ['XOM'],
    { getHistory: fakeGetHistory }
  );
  const five = out.perWindow['5d'];
  assert.equal(five.n, 3);
  assert.ok(Math.abs(five.mean - 0.04 / 3) < 1e-9, `mean=${five.mean}`);
  assert.ok(Math.abs(five.median - 0.01) < 1e-9, `median=${five.median}`);
  // Hand-computed sample std ≈ 0.035118845.
  assert.ok(Math.abs(five.std - 0.035118845) < 1e-6, `std=${five.std}`);
  // Hand-computed t ≈ 0.65759. mean / (std/sqrt(n))
  // = (0.04/3) / (0.035118845 / sqrt(3)) ≈ 0.65759.
  assert.ok(Math.abs(five.tStat - 0.65759) < 1e-3, `t=${five.tStat}`);
});

// An event whose T+N close runs past the end of the bar series → that
// observation is dropped from n. The aggregate is still computed from
// whatever valid observations remain. Here, event A keeps a real
// 5d return; event B's T+5 is past the cliff and falls out of n.
test('runEventStudy: missing T+N bar → that observation is skipped, n drops, mean uses survivors', async () => {
  // Event A on 2024-01-02, bars run far enough out to satisfy the 5d
  // window. Event B on 2024-06-03 has only 3 future bars, not enough.
  const xomBars = [
    ...bars('2024-01-02', [100, 101, 102, 103, 104, 105]),
    ...bars('2024-06-03', [50, 51, 52, 53]),
  ];
  const spyBars = [
    ...bars('2024-01-02', [100, 100, 100, 100, 100, 102]),
    ...bars('2024-06-03', [50, 50, 50, 50]),
  ];
  const fakeGetHistory = async (t) => {
    if (t === 'XOM') return xomBars;
    if (t === 'SPY') return spyBars;
    return [];
  };
  const out = await runEventStudy(
    [
      { date: '2024-01-02', label: 'A' },
      { date: '2024-06-03', label: 'B' },
    ],
    ['XOM'],
    { getHistory: fakeGetHistory }
  );
  const five = out.perWindow['5d'];
  // Only event A's 5d observation survived → n=1, abnormal = 0.05-0.02
  // = 0.03 by construction.
  assert.equal(five.n, 1);
  assert.ok(Math.abs(five.mean - 0.03) < 1e-9, `mean=${five.mean}`);
  // The 1d window still has both observations (T+1 exists in both
  // series for both events): A → ticker 1%, SPY 0% → 0.01.
  // B → ticker (51/50)-1 = 0.02, SPY 0 → 0.02. mean = 0.015.
  const one = out.perWindow['1d'];
  assert.equal(one.n, 2);
  assert.ok(Math.abs(one.mean - 0.015) < 1e-9, `1d mean=${one.mean}`);
});

// Ticker and SPY trade on different non-trading days. The primitive
// must anchor t0/tN independently on each series from the event date.
// If SPY is missing a t0 (no bar ≥ the event date) or its tN runs past
// its tail, that observation is skipped — but only that observation.
test('runEventStudy: anchors ticker and SPY independently; missing SPY endpoint skips just that obs', async () => {
  // Ticker has bars from 2024-01-02 onward; SPY's series ends on
  // 2024-01-05, so its T+5 from 2024-01-02 (index 0 → 5) is past the
  // end. The 1d window still has both endpoints on both series.
  const xomBars = bars('2024-01-02', [100, 101, 102, 103, 104, 105]);
  const spyBars = bars('2024-01-02', [100, 100, 100, 100]); // ends short
  const fakeGetHistory = async (t) => {
    if (t === 'XOM') return xomBars;
    if (t === 'SPY') return spyBars;
    return [];
  };
  const out = await runEventStudy(
    [{ date: '2024-01-02', label: 'A' }],
    ['XOM'],
    { getHistory: fakeGetHistory }
  );
  // 1d: ticker (101/100)-1 = 0.01, SPY (100/100)-1 = 0 → abnormal 0.01.
  assert.equal(out.perWindow['1d'].n, 1);
  assert.ok(Math.abs(out.perWindow['1d'].mean - 0.01) < 1e-9);
  // 5d: SPY has no T+5 → observation skipped → n=0.
  assert.equal(out.perWindow['5d'].n, 0);
  assert.equal(out.perWindow['5d'].mean, 0);
  // 20d: same — past both ends → n=0.
  assert.equal(out.perWindow['20d'].n, 0);
});

// One call must compute 1d/5d/20d independently — the windows don't
// stomp each other and each gets its own aggregate.
test('runEventStudy: 1d/5d/20d computed independently in one call', async () => {
  // 21 bars so the 20d window lands; closes designed so each window's
  // abnormal is distinct: 1d=0.005, 5d=0.025, 20d=0.10.
  const xomCloses = [100];
  for (let i = 1; i <= 25; i++) xomCloses.push(100 * (1 + i * 0.01));
  // SPY: flat at 100 for the whole range — so the abnormal is just the
  // ticker's own return at each window.
  const spyCloses = Array(26).fill(100);
  // Above: at i=1, ticker = 101 → 1d return 0.01; at i=5, ticker = 105
  // → 5d return 0.05; at i=20, ticker = 120 → 20d return 0.20.
  const xomBars = bars('2024-01-02', xomCloses);
  const spyBars = bars('2024-01-02', spyCloses);
  const fakeGetHistory = async (t) => {
    if (t === 'XOM') return xomBars;
    if (t === 'SPY') return spyBars;
    return [];
  };
  const out = await runEventStudy(
    [{ date: '2024-01-02', label: 'A' }],
    ['XOM'],
    { getHistory: fakeGetHistory }
  );
  assert.ok(Math.abs(out.perWindow['1d'].mean - 0.01) < 1e-9);
  assert.ok(Math.abs(out.perWindow['5d'].mean - 0.05) < 1e-9);
  assert.ok(Math.abs(out.perWindow['20d'].mean - 0.20) < 1e-9);
});

// Empty events / empty basket / missing bars / non-monotonic — none of
// these throw. The shape is always there and well-formed; n collapses
// to zero where there's nothing to compute.
test('runEventStudy: empty events → no-throw empty result', async () => {
  const out = await runEventStudy([], ['XOM'], { getHistory: async () => [] });
  assert.equal(out.perWindow['1d'].n, 0);
  assert.equal(out.perWindow['5d'].n, 0);
  assert.equal(out.perWindow['20d'].n, 0);
  assert.deepEqual(out.perEvent, []);
});

test('runEventStudy: empty basket → no-throw empty result', async () => {
  const out = await runEventStudy(
    [{ date: '2024-01-02', label: 'X' }],
    [],
    { getHistory: async () => [] }
  );
  assert.equal(out.perWindow['5d'].n, 0);
  assert.deepEqual(out.perEvent, []);
});

test('runEventStudy: getHistory returning null/undefined → safe, empty result, no throw', async () => {
  const out = await runEventStudy(
    [{ date: '2024-01-02', label: 'X' }],
    ['XOM'],
    { getHistory: async () => null }
  );
  assert.equal(out.perWindow['5d'].n, 0);
});

test('runEventStudy: undefined deps falls through (would call default getHistory) — but with empty events, never touches it', async () => {
  // The default uses the real priceHistory.getHistory, which would hit
  // the DB. With an empty events list there's nothing to fetch.
  const out = await runEventStudy([], ['XOM']);
  assert.equal(out.perWindow['5d'].n, 0);
});
