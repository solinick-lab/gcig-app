import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMacroSensitivity, _resetFactorSensitivityCache } from './factorSensitivity.js';

// factorSensitivity.js — the assembled regression: every holding's
// daily returns regressed on each macro factor over a 252-trading-day
// lookback, then aggregated to a portfolio β per factor with the
// market-value-weighted scheme. Same deps-injection contract every
// terminal service uses to keep the test off the network: pass in
// fakes for getSheetPortfolio / getHistory / getFredSeries and assert
// the shape + math against hand-built bars.

// A small reusable portfolio: two real holdings + a cash row that
// must be filtered out (the cash sleeve is tracked but not regressed —
// FGTXX/BDADDA are treated as cash per the user's standing memo).
const FAKE_PORTFOLIO = {
  holdings: [
    { ticker: 'AAA', name: 'AAA Co', marketValue: 60_000, isCash: false },
    { ticker: 'BBB', name: 'BBB Inc', marketValue: 40_000, isCash: false },
    { ticker: 'FGTXX', name: 'Cash sleeve', marketValue: 20_000, isCash: true },
  ],
};

// Deterministic price bars: 5 trading days at known closes. Returns
// off close-to-close should be exactly (close[i]/close[i-1] - 1).
// AAA bars: closes [100, 102, 101, 103, 104] →
//   rets ≈ [0.02, -0.00980392…, 0.01980198…, 0.00970874…]
// BBB bars: closes [50, 51, 50, 49, 51] →
//   rets ≈ [0.02, -0.01960784…, -0.02, 0.04081632…]
const AAA_BARS = [
  { date: '2026-04-01', close: 100 },
  { date: '2026-04-02', close: 102 },
  { date: '2026-04-03', close: 101 },
  { date: '2026-04-04', close: 103 },
  { date: '2026-04-07', close: 104 },
];
const BBB_BARS = [
  { date: '2026-04-01', close: 50 },
  { date: '2026-04-02', close: 51 },
  { date: '2026-04-03', close: 50 },
  { date: '2026-04-04', close: 49 },
  { date: '2026-04-07', close: 51 },
];
const SPY_BARS = [
  { date: '2026-04-01', close: 500 },
  { date: '2026-04-02', close: 510 },
  { date: '2026-04-03', close: 505 },
  { date: '2026-04-04', close: 515 },
  { date: '2026-04-07', close: 520 },
];

// A `delta` factor: DGS10 yield level in percent. Daily Δ in
// percentage points means rets = [4.20-4.15, 4.18-4.20, 4.25-4.18, 4.30-4.25]
// = [0.05, -0.02, 0.07, 0.05]. Note: 5 obs → 4 returns (first skipped).
const DGS10_OBS = [
  { date: '2026-04-01', value: 4.15 },
  { date: '2026-04-02', value: 4.20 },
  { date: '2026-04-03', value: 4.18 },
  { date: '2026-04-04', value: 4.25 },
  { date: '2026-04-07', value: 4.30 },
];

// A `relative` factor: WTI oil prices. Daily relative returns =
// [80/79-1, 81/80-1, 79/81-1, 82/79-1].
const WTI_OBS = [
  { date: '2026-04-01', value: 79.00 },
  { date: '2026-04-02', value: 80.00 },
  { date: '2026-04-03', value: 81.00 },
  { date: '2026-04-04', value: 79.00 },
  { date: '2026-04-07', value: 82.00 },
];

// Make any per-id factor lookup deterministic. The service asks for
// either a FRED series or 'SPY' bars; build a one-shop fake that
// returns whichever is asked for.
function makeFakeDeps(overrides = {}) {
  const histMap = {
    AAA: AAA_BARS,
    BBB: BBB_BARS,
    SPY: SPY_BARS,
    ...(overrides.histMap || {}),
  };
  const fredMap = {
    DGS10: DGS10_OBS,
    DCOILWTICO: WTI_OBS,
    // Empty by default; specific tests override to test n filters.
    DTWEXBGS: [],
    VIXCLS: [],
    ...(overrides.fredMap || {}),
  };
  return {
    getSheetPortfolio: overrides.getSheetPortfolio || (async () => overrides.portfolio || FAKE_PORTFOLIO),
    getHistory: overrides.getHistory || (async (t) => histMap[t] || []),
    getFredSeries: overrides.getFredSeries || (async (id) => fredMap[id] || []),
  };
}

test('returns the documented top-level shape', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(makeFakeDeps());
  assert.equal(typeof r.asOf, 'string', 'asOf must be a string timestamp');
  assert.equal(r.lookbackDays, 252, 'lookback is the locked 252-td default');
  assert.ok(Array.isArray(r.factors), 'factors must be an array');
  assert.equal(r.factors.length, 5, 'five factors: DGS10/WTI/USD/VIX/SPY');
  assert.deepEqual(
    r.factors.map((f) => f.id),
    ['DGS10', 'DCOILWTICO', 'DTWEXBGS', 'VIXCLS', 'SPY'],
    'factor ids and order match the documented catalog'
  );
  // Cash is excluded; only the two real holdings should ride into the
  // per-ticker outputs.
  assert.deepEqual(r.holdings, ['AAA', 'BBB']);
  assert.deepEqual(r.marketValues, { AAA: 60_000, BBB: 40_000 });
});

test('each factor row carries id, label, source, kind, unit, defaultShock + portfolioBeta + scenario + perTicker[] + surviving[]', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(makeFakeDeps());
  for (const f of r.factors) {
    assert.ok(typeof f.id === 'string', `factor.id missing on ${JSON.stringify(f)}`);
    assert.ok(typeof f.label === 'string', `factor.label missing on ${f.id}`);
    assert.ok(['fred', 'price'].includes(f.source), `factor.source on ${f.id}`);
    assert.ok(['delta', 'relative'].includes(f.kind), `factor.kind on ${f.id}`);
    assert.ok(typeof f.unit === 'string', `factor.unit on ${f.id}`);
    assert.ok(typeof f.defaultShock === 'number', `factor.defaultShock on ${f.id}`);
    assert.ok(typeof f.portfolioBeta === 'number', `factor.portfolioBeta on ${f.id}`);
    assert.ok(f.scenario && typeof f.scenario.shock === 'number');
    assert.ok(typeof f.scenario.expectedMove === 'number');
    assert.ok(Array.isArray(f.perTicker));
    assert.ok(Array.isArray(f.surviving));
    assert.ok(Array.isArray(f.topContributors));
  }
});

// Delta vs relative — the methodological choice that the panel footer
// flags. For DGS10 (kind=delta), the regressor must be Δ in points.
// For DCOILWTICO (kind=relative), the regressor must be relative
// price returns. We poke at the perTicker β for AAA against each.
//
// AAA returns (4 obs, skipping the first bar):
//   r_aaa = [102/100-1, 101/102-1, 103/101-1, 104/103-1]
//         ≈ [0.02000000, -0.00980392, 0.01980198, 0.00970874]
//
// DGS10 deltas (4 obs):
//   Δ = [4.20-4.15, 4.18-4.20, 4.25-4.18, 4.30-4.25]
//     = [0.05, -0.02, 0.07, 0.05]
// Hand: xBar=0.0375, yBar=(0.02 - 0.00980392 + 0.01980198 + 0.00970874)/4
//      ≈ 0.0099267
// Sxx = Σ(xi - xBar)² = (0.0125)² + (-0.0575)² + (0.0325)² + (0.0125)²
//     = 0.00015625 + 0.00330625 + 0.00105625 + 0.00015625 = 0.004675
// Sxy = (0.0125)(0.02 - 0.0099267) + (-0.0575)(-0.00980392 - 0.0099267)
//     + (0.0325)(0.01980198 - 0.0099267) + (0.0125)(0.00970874 - 0.0099267)
//     = (0.0125)(0.0100733) + (-0.0575)(-0.0197306) + (0.0325)(0.0098753) + (0.0125)(-0.0002180)
//     ≈ 0.000125916 + 0.001134510 + 0.000320947 - 0.000002725
//     ≈ 0.001578648
// β_aaa,DGS10 ≈ 0.001578648 / 0.004675 ≈ 0.337678
//
// We don't need to assert this to 1e-6 here — that's what the
// runRegression hand-tests are for. We assert *direction*:
//   - DGS10 row uses delta (β is the OLS slope of r_aaa on Δ in pp).
//   - DCOILWTICO row uses relative.
// The crucial distinction the test catches is the wrong-kind regression
// would yield a numerically different β.
test('factor.kind="delta" regresses on daily diff; "relative" regresses on daily ratio', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(makeFakeDeps());

  const dgs10 = r.factors.find((f) => f.id === 'DGS10');
  const wti = r.factors.find((f) => f.id === 'DCOILWTICO');
  assert.ok(dgs10 && wti, 'DGS10 and DCOILWTICO must both be present');
  assert.equal(dgs10.kind, 'delta');
  assert.equal(wti.kind, 'relative');

  // Hand-compute the β AAA on DGS10 (kind=delta) and verify the
  // service emits exactly that. (Inputs are small enough that the
  // sum is exact in IEEE 754 to many decimals.)
  // AAA returns:
  const yAAA = [
    102 / 100 - 1,
    101 / 102 - 1,
    103 / 101 - 1,
    104 / 103 - 1,
  ];
  // DGS10 deltas:
  const xDGS10 = [4.20 - 4.15, 4.18 - 4.20, 4.25 - 4.18, 4.30 - 4.25];
  // Manual OLS for cross-check (mirrors runRegression):
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const ymean = mean(yAAA);
  const xmean = mean(xDGS10);
  let Sxx = 0, Sxy = 0;
  for (let i = 0; i < yAAA.length; i++) {
    Sxx += (xDGS10[i] - xmean) * (xDGS10[i] - xmean);
    Sxy += (xDGS10[i] - xmean) * (yAAA[i] - ymean);
  }
  const expectedBeta = Sxy / Sxx;
  const aaaRow = dgs10.perTicker.find((p) => p.ticker === 'AAA');
  assert.ok(aaaRow, 'AAA must appear in DGS10 perTicker');
  assert.equal(aaaRow.n, 4, 'four return observations after skipping the first bar');
  assert.ok(
    Math.abs(aaaRow.beta - expectedBeta) < 1e-9,
    `AAA/DGS10 β: expected ${expectedBeta}, got ${aaaRow.beta}`
  );

  // WTI (kind=relative): regress AAA returns on WTI's relative returns.
  const xWTI = [80 / 79 - 1, 81 / 80 - 1, 79 / 81 - 1, 82 / 79 - 1];
  const xWtiMean = mean(xWTI);
  let SxxW = 0, SxyW = 0;
  for (let i = 0; i < yAAA.length; i++) {
    SxxW += (xWTI[i] - xWtiMean) * (xWTI[i] - xWtiMean);
    SxyW += (xWTI[i] - xWtiMean) * (yAAA[i] - ymean);
  }
  const expectedBetaWti = SxyW / SxxW;
  const aaaWti = wti.perTicker.find((p) => p.ticker === 'AAA');
  assert.ok(
    Math.abs(aaaWti.beta - expectedBetaWti) < 1e-9,
    `AAA/WTI β: expected ${expectedBetaWti}, got ${aaaWti.beta}`
  );
});

// n ≥ 60 filter — a holding with too few aligned observations is
// excluded from the portfolio aggregate. To exercise this on synthetic
// data we set BBB's history to ONLY 30 bars: 29 returns after the
// first-bar skip, well under 60. The DGS10 row's surviving list
// should contain only AAA (which has 4 returns under the test —
// also too few). Edge case: in the synthetic test all returns are
// <60, so ALL tickers should be excluded → portfolioBeta = 0.
test('n < 60 filter excludes thinly-covered tickers from the portfolio aggregate', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(makeFakeDeps());
  const dgs10 = r.factors.find((f) => f.id === 'DGS10');
  // Per-ticker β rows still record n=4 for each; the *surviving* list
  // (those that made the n≥60 cut) is empty.
  assert.deepEqual(
    dgs10.surviving,
    [],
    'no synthetic ticker has 60 aligned observations, so the surviving set is empty'
  );
  assert.equal(
    dgs10.portfolioBeta,
    0,
    'with no surviving tickers, portfolio β collapses to 0 honestly'
  );
});

// Weight redistribution — when only a subset of tickers survives the
// n≥60 cut, weights are recomputed *over the survivors only* and
// sum to 1. To exercise this on synthetic data we generate enough
// bars (80 obs → 79 returns) for both AAA and BBB; the surviving
// set is {AAA, BBB} with weights 0.6 / 0.4 (their MV ratios after
// cash exclusion). Then we drop BBB to 30 bars → only AAA survives →
// AAA's effective weight should be 1.0, not 0.6.
test('weights are renormalized over the surviving subset', async () => {
  _resetFactorSensitivityCache();
  // 80 bars for AAA, 30 for BBB. DGS10 also gets 80.
  const longBars = (close0, drift) =>
    Array.from({ length: 80 }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}+${i}`,
      close: close0 + drift * i,
    }));
  // Date format above isn't a real ISO — we just need unique strings
  // that align between AAA/BBB/SPY/DGS10. The intersection is purely
  // string-key equality. We rebuild dates with a deterministic
  // sequential key so the alignment always hits.
  const dseq = (i) => `2026-K-${String(i).padStart(3, '0')}`;
  const bars80 = (close0, drift) =>
    Array.from({ length: 80 }, (_, i) => ({
      date: dseq(i),
      close: close0 + drift * i,
    }));
  const bars30 = (close0, drift) =>
    Array.from({ length: 30 }, (_, i) => ({
      date: dseq(i),
      close: close0 + drift * i,
    }));
  const fredSeries80 = (start, step) =>
    Array.from({ length: 80 }, (_, i) => ({
      date: dseq(i),
      value: start + step * i,
    }));

  const aaa80 = bars80(100, 0.5);
  const bbb30 = bars30(50, 0.25);
  const spy80 = bars80(500, 1);
  const dgs10_80 = fredSeries80(4, 0.01);

  const deps = makeFakeDeps({
    histMap: { AAA: aaa80, BBB: bbb30, SPY: spy80 },
    fredMap: { DGS10: dgs10_80, DCOILWTICO: [], DTWEXBGS: [], VIXCLS: [] },
  });

  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(deps);
  const dgs10 = r.factors.find((f) => f.id === 'DGS10');

  // BBB has 29 returns after skipping the first bar → under 60 → excluded.
  // AAA has 79 returns → survives. Aggregate weight redistribution
  // should set AAA's effective weight to 1.0.
  assert.deepEqual(dgs10.surviving, ['AAA']);
  // portfolioBeta = w_AAA * β_AAA. With w renormalized to 1.0, this
  // equals β_AAA exactly.
  const aaaRow = dgs10.perTicker.find((p) => p.ticker === 'AAA');
  assert.ok(
    Math.abs(dgs10.portfolioBeta - aaaRow.beta) < 1e-12,
    `portfolio β should equal AAA β under renormalization: pb=${dgs10.portfolioBeta} aaa=${aaaRow.beta}`
  );
});

// topContributors — top 3 by |β × w|. With two surviving tickers,
// the order should reflect the absolute product of β and w. The
// synthetic data above is constructed so β has opposite signs across
// AAA and BBB, but we keep this test small and assertion-light:
// just that the contributor list is sorted desc by |β × w| and
// each entry carries a useful contribution number.
test('topContributors ranks by |β × w| desc (top 3) with both members surviving', async () => {
  _resetFactorSensitivityCache();
  // Two long histories so both AAA and BBB survive. Use linear ramps
  // with different slopes so neither β collapses to 0.
  const dseq = (i) => `2026-K-${String(i).padStart(3, '0')}`;
  const bars80 = (closes) =>
    closes.map((close, i) => ({ date: dseq(i), close }));
  // AAA: gentle ramp + sinusoid. BBB: steeper inverse-ramp.
  const aaaCloses = Array.from({ length: 80 }, (_, i) => 100 + i * 0.3 + Math.sin(i / 4));
  const bbbCloses = Array.from({ length: 80 }, (_, i) => 50 - i * 0.05 + Math.cos(i / 3));
  const spyCloses = Array.from({ length: 80 }, (_, i) => 500 + i * 0.5);
  const aaa80 = bars80(aaaCloses);
  const bbb80 = bars80(bbbCloses);
  const spy80 = bars80(spyCloses);
  const dgs10_80 = Array.from({ length: 80 }, (_, i) => ({
    date: dseq(i),
    value: 4 + 0.01 * i + 0.05 * Math.sin(i / 5),
  }));

  const deps = makeFakeDeps({
    histMap: { AAA: aaa80, BBB: bbb80, SPY: spy80 },
    fredMap: { DGS10: dgs10_80, DCOILWTICO: [], DTWEXBGS: [], VIXCLS: [] },
  });

  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(deps);
  const dgs10 = r.factors.find((f) => f.id === 'DGS10');

  assert.deepEqual(new Set(dgs10.surviving), new Set(['AAA', 'BBB']));
  assert.ok(dgs10.topContributors.length >= 1, 'at least one contributor');
  assert.ok(dgs10.topContributors.length <= 3, 'never more than 3');
  // Sort discipline: contribution must be monotone non-increasing.
  for (let i = 1; i < dgs10.topContributors.length; i++) {
    const prev = Math.abs(dgs10.topContributors[i - 1].contribution);
    const cur = Math.abs(dgs10.topContributors[i].contribution);
    assert.ok(prev >= cur, `contributors must be sorted by |β·w| desc`);
  }
  // Each contributor exposes ticker, β, weight, contribution (β × w).
  for (const c of dgs10.topContributors) {
    assert.ok(typeof c.ticker === 'string');
    assert.ok(typeof c.beta === 'number');
    assert.ok(typeof c.weight === 'number');
    assert.ok(typeof c.contribution === 'number');
    assert.ok(
      Math.abs(c.contribution - c.beta * c.weight) < 1e-12,
      'contribution must equal β × weight'
    );
  }
});

// Scenario math is intentionally trivial: expectedMove = portfolioBeta
// × defaultShock. Verify it's exact arithmetic, not a rounded display
// number — the panel reads this for the "+50bps → book ~X.X%" cue.
test('scenario expectedMove = portfolioBeta × defaultShock (exact)', async () => {
  _resetFactorSensitivityCache();
  // Use the surviving setup so portfolioBeta is non-zero.
  const dseq = (i) => `2026-K-${String(i).padStart(3, '0')}`;
  const aaaCloses = Array.from({ length: 80 }, (_, i) => 100 + i);
  const bbbCloses = Array.from({ length: 80 }, (_, i) => 50 + i * 0.5);
  const spyCloses = Array.from({ length: 80 }, (_, i) => 500 + i * 0.7);
  const bars80 = (closes) => closes.map((close, i) => ({ date: dseq(i), close }));
  const dgs10_80 = Array.from({ length: 80 }, (_, i) => ({ date: dseq(i), value: 4 + 0.02 * i }));

  const deps = makeFakeDeps({
    histMap: { AAA: bars80(aaaCloses), BBB: bars80(bbbCloses), SPY: bars80(spyCloses) },
    fredMap: { DGS10: dgs10_80, DCOILWTICO: [], DTWEXBGS: [], VIXCLS: [] },
  });
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(deps);
  for (const f of r.factors) {
    assert.equal(f.scenario.shock, f.defaultShock);
    assert.ok(
      Math.abs(f.scenario.expectedMove - f.portfolioBeta * f.defaultShock) < 1e-12,
      `${f.id}: expectedMove must equal portfolioBeta × defaultShock`
    );
  }
});

// Cash is filtered out via isCash before regression. The portfolio's
// effective universe is the non-cash holdings. The cash sleeve must
// never appear in perTicker or surviving lists.
test('cash holdings are excluded from the regression universe', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity(makeFakeDeps());
  for (const f of r.factors) {
    assert.ok(!f.perTicker.some((p) => p.ticker === 'FGTXX'), `FGTXX leaked into ${f.id}`);
    assert.ok(!f.surviving.includes('FGTXX'), `FGTXX surviving on ${f.id}`);
  }
  assert.ok(!r.holdings.includes('FGTXX'));
});

// Never-throws on injected failure. The portfolio fetch, the price
// fetch, and the FRED fetch all can fail in production; the service
// degrades each cell honestly and the route still serves 200.
test('never throws if injected getSheetPortfolio rejects', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity({
    getSheetPortfolio: async () => { throw new Error('sheet down'); },
    getHistory: async () => [],
    getFredSeries: async () => [],
  });
  assert.ok(r);
  assert.equal(r.lookbackDays, 252);
  assert.deepEqual(r.holdings, []);
});

test('never throws if injected getHistory rejects', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity({
    getSheetPortfolio: async () => FAKE_PORTFOLIO,
    getHistory: async () => { throw new Error('NASDAQ 502'); },
    getFredSeries: async () => DGS10_OBS,
  });
  assert.ok(r);
  // Every per-ticker β should be the honest-zero record.
  for (const f of r.factors) {
    for (const row of f.perTicker) {
      assert.equal(row.beta, 0);
      assert.equal(row.n, 0);
    }
  }
});

test('never throws if injected getFredSeries rejects (empty FRED)', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity({
    getSheetPortfolio: async () => FAKE_PORTFOLIO,
    getHistory: async (t) => (t === 'SPY' ? SPY_BARS : AAA_BARS),
    getFredSeries: async () => { throw new Error('FRED down'); },
  });
  assert.ok(r);
  // FRED factors collapse to honest n=0 rows; SPY (the price-source
  // factor) still has values because getHistory still works.
  const spy = r.factors.find((f) => f.id === 'SPY');
  assert.equal(spy.source, 'price');
  for (const row of spy.perTicker) {
    // 5 SPY bars → 4 returns; AAA/BBB also 5 bars → 4 returns; aligned.
    assert.equal(row.n, 4);
  }
});

test('never throws on empty universe (no holdings at all)', async () => {
  _resetFactorSensitivityCache();
  const r = await getMacroSensitivity({
    getSheetPortfolio: async () => ({ holdings: [] }),
    getHistory: async () => SPY_BARS,
    getFredSeries: async () => DGS10_OBS,
  });
  assert.ok(r);
  assert.deepEqual(r.holdings, []);
  for (const f of r.factors) {
    assert.deepEqual(f.perTicker, []);
    assert.deepEqual(f.surviving, []);
    assert.equal(f.portfolioBeta, 0);
  }
});
