import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getWeatherImpact, _resetWeatherImpactCache } from './weatherSignals.js';

// The per-exposure study result rides a 6h cache in this process, so
// every test starts from a clean cache or it would pick up the prior
// test's injected study. Same precedent the liveQuotes / insiderTx
// suites set with their _reset* helpers.
beforeEach(() => _resetWeatherImpactCache());

// The shape under the WX panel: pull the HURDAT2 landfall fixture +
// the curated exposure baskets + the event-study primitive, plus a
// best-effort NHC active-storms fetch, and assemble the
// { asOf, activeStorms, exposures } envelope. Every dep is injectable
// for tests so we never touch the DB, the network, or the real fixture.

// Hand-crafted minimal fixture so the assembled output is fully
// hand-computable. Two events, one ticker overlap per exposure.
const fakeLandfalls = [
  { name: 'A', date: '2024-01-02', category: 'Tropical Storm', season: 2024 },
  { name: 'B', date: '2024-06-03', category: 'Hurricane Cat 1', season: 2024 },
];

// The stand-in event-study returns a deterministic shape regardless of
// the basket — the assembly is what we're testing here, not the math
// (math has its own test suite). Recording the call lets us assert
// that every exposure received its own basket of tickers.
function fakeEventStudyFactory() {
  const calls = [];
  return {
    calls,
    runEventStudy: async (events, basket) => {
      calls.push({ events, basket });
      return {
        perWindow: {
          '1d': { mean: 0.001, median: 0.001, std: 0, n: 1, tStat: 0 },
          '5d': { mean: 0.005, median: 0.005, std: 0, n: 1, tStat: 0 },
          '20d': { mean: 0.02, median: 0.02, std: 0, n: 1, tStat: 0 },
        },
        perEvent: [],
      };
    },
  };
}

// The happy path: every exposure card carries its label, its tickers
// rationale, the study output, and the user's holdings overlap. The
// active-storm list comes straight off the NHC stub. The asOf is an
// ISO timestamp.
test('getWeatherImpact: assembles { asOf, activeStorms, exposures } with holdings overlap per basket', async () => {
  const es = fakeEventStudyFactory();
  const out = await getWeatherImpact(['XOM', 'HIG', 'AAPL'], {
    landfalls: fakeLandfalls,
    runEventStudy: es.runEventStudy,
    getActiveStorms: async () => [
      { name: 'Storm1', classification: 'TS', intensity: 50, lastUpdate: '2026-05-19T12:00:00Z' },
    ],
  });
  assert.ok(typeof out.asOf === 'string' && out.asOf.length >= 20, 'asOf is an ISO timestamp');
  assert.equal(Array.isArray(out.activeStorms), true);
  assert.equal(out.activeStorms.length, 1);
  assert.equal(out.activeStorms[0].name, 'Storm1');
  assert.equal(Array.isArray(out.exposures), true);
  // Two baskets in EXPOSURES (gulf_oil_gas + pc_insurers); both should
  // be surfaced even when only one of the user's holdings touches each.
  assert.equal(out.exposures.length, 2);
  const gulf = out.exposures.find((e) => e.exposure.id === 'gulf_oil_gas');
  const pc = out.exposures.find((e) => e.exposure.id === 'pc_insurers');
  assert.ok(gulf, 'gulf_oil_gas exposure must be present');
  assert.ok(pc, 'pc_insurers exposure must be present');
  // Holdings overlap: XOM is in the gulf basket, HIG in the P&C basket.
  // AAPL touches neither and never appears in any overlap.
  assert.deepEqual(gulf.holdingsOverlap, ['XOM']);
  assert.deepEqual(pc.holdingsOverlap, ['HIG']);
  // The study output is forwarded as-is per exposure.
  assert.equal(gulf.study.perWindow['5d'].mean, 0.005);
  assert.equal(pc.study.perWindow['5d'].mean, 0.005);
  // runEventStudy was called once per exposure, with the landfall
  // events and that exposure's ticker basket.
  assert.equal(es.calls.length, 2);
  const baskets = es.calls.map((c) => c.basket);
  assert.ok(baskets.some((b) => b.includes('XOM')), 'gulf basket included XOM');
  assert.ok(baskets.some((b) => b.includes('HIG')), 'pc basket included HIG');
});

// Empty holdings — the user has no exposure to either basket. The
// exposures still surface (informational), with an empty overlap.
test('getWeatherImpact: empty holdings → both exposures surface with empty overlap', async () => {
  const es = fakeEventStudyFactory();
  const out = await getWeatherImpact([], {
    landfalls: fakeLandfalls,
    runEventStudy: es.runEventStudy,
    getActiveStorms: async () => [],
  });
  assert.equal(out.exposures.length, 2);
  for (const e of out.exposures) {
    assert.deepEqual(e.holdingsOverlap, []);
  }
});

// The case-folding contract: holdings may arrive lowercase from the
// sheet; the overlap is computed case-insensitively but rendered
// upper-case (which is what the basket config uses).
test('getWeatherImpact: holdings overlap is case-insensitive, rendered upper-case', async () => {
  const es = fakeEventStudyFactory();
  const out = await getWeatherImpact(['xom', 'oxy', 'hig'], {
    landfalls: fakeLandfalls,
    runEventStudy: es.runEventStudy,
    getActiveStorms: async () => [],
  });
  const gulf = out.exposures.find((e) => e.exposure.id === 'gulf_oil_gas');
  assert.deepEqual(gulf.holdingsOverlap.sort(), ['OXY', 'XOM']);
});

// NHC live-feed failure must NOT crash the panel — activeStorms
// degrades to []. The historical playbook still runs.
test('getWeatherImpact: NHC feed failure → activeStorms:[] (never throws)', async () => {
  const es = fakeEventStudyFactory();
  const out = await getWeatherImpact(['XOM'], {
    landfalls: fakeLandfalls,
    runEventStudy: es.runEventStudy,
    getActiveStorms: async () => {
      throw new Error('NHC unreachable');
    },
  });
  assert.deepEqual(out.activeStorms, []);
  // The historical playbook is unaffected.
  assert.equal(out.exposures.length, 2);
});

// And: an event-study rejection on one exposure must not poison the
// others. (This guards against a future basket whose ticker basket
// can't be fetched cleanly.)
test('getWeatherImpact: a per-exposure event-study failure is contained — that exposure surfaces with an empty study, others unaffected', async () => {
  let nth = 0;
  const flaky = async () => {
    nth += 1;
    if (nth === 1) throw new Error('boom');
    return {
      perWindow: {
        '1d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
        '5d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
        '20d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
      },
      perEvent: [],
    };
  };
  const out = await getWeatherImpact(['XOM', 'HIG'], {
    landfalls: fakeLandfalls,
    runEventStudy: flaky,
    getActiveStorms: async () => [],
  });
  assert.equal(out.exposures.length, 2);
  // The first exposure's study fell out to the honest-empty stub.
  const broke = out.exposures[0];
  assert.equal(broke.study.perWindow['5d'].n, 0);
});

// Empty fixture (zero landfalls in the archive) — the assembly still
// runs, every exposure has an empty study aggregate, holdings overlap
// honest.
test('getWeatherImpact: empty landfalls fixture → exposures present, all studies empty (no throw)', async () => {
  // Inject a runEventStudy that asserts the empty events get passed
  // through as-is, and returns the no-throw empty shape itself would.
  const out = await getWeatherImpact(['XOM'], {
    landfalls: [],
    runEventStudy: async (events) => {
      assert.deepEqual(events, []);
      return {
        perWindow: {
          '1d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
          '5d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
          '20d': { mean: 0, median: 0, std: 0, n: 0, tStat: 0 },
        },
        perEvent: [],
      };
    },
    getActiveStorms: async () => [],
  });
  assert.equal(out.exposures.length, 2);
  for (const e of out.exposures) {
    assert.equal(e.study.perWindow['5d'].n, 0);
  }
});
