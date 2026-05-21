import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConcept, extractFundamentals } from './secFundamentals.js';

// The brittle part of XBRL is that a single 10-K tags the full year and
// the trailing quarters under the same concept, that concept names drift
// between filers, and that restatements re-tag a year that was already
// reported. These fixtures pin the duration filter, the concept
// fallback, the latest-filed dedupe, and the derived margins on the
// {start,end,val,fy,fp,form,filed} shape SEC returns under
// facts['us-gaap'][Concept].units[unit].
function facts() {
  return {
    facts: {
      'us-gaap': {
        Revenues: {
          units: {
            USD: [
              { start: '2022-01-01', end: '2022-12-31', val: 1000, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-02-01' },
              { start: '2023-01-01', end: '2023-12-31', val: 1200, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' },
              // Same FY2023, restated and filed later — must win the dedupe.
              { start: '2023-01-01', end: '2023-12-31', val: 1250, fy: 2023, fp: 'FY', form: '10-K/A', filed: '2024-06-01' },
              // A quarter inside 2023 — must not count as an annual point.
              { start: '2023-01-01', end: '2023-03-31', val: 300, fy: 2023, fp: 'Q1', form: '10-Q', filed: '2023-05-01' },
            ],
          },
        },
        GrossProfit: {
          units: { USD: [{ start: '2023-01-01', end: '2023-12-31', val: 500, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' }] },
        },
        NetIncomeLoss: {
          units: {
            USD: [
              { start: '2022-01-01', end: '2022-12-31', val: 100, fy: 2022, fp: 'FY', form: '10-K', filed: '2023-02-01' },
              { start: '2023-01-01', end: '2023-12-31', val: 150, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' },
            ],
          },
        },
        EarningsPerShareDiluted: {
          units: { 'USD/shares': [{ start: '2023-01-01', end: '2023-12-31', val: 1.5, fy: 2023, fp: 'FY', form: '10-K', filed: '2024-02-01' }] },
        },
      },
    },
  };
}

test('annual extract dedupes a fiscal year to the latest filing', () => {
  const m = extractConcept(facts(), ['Revenues'], { unit: 'USD', freq: 'annual' });
  assert.equal(m.get('FY2023').val, 1250); // restated value wins
  assert.equal(m.get('FY2022').val, 1000);
  assert.equal(m.size, 2); // the Q1 row is not an annual point
});

test('concept fallback resolves the first reported tag', () => {
  const m = extractConcept(
    facts(),
    ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues'],
    { unit: 'USD', freq: 'annual' }
  );
  assert.equal(m.get('FY2023').val, 1250);
});

test('quarterly extract keeps the ~90-day period and drops the full year', () => {
  const m = extractConcept(facts(), ['Revenues'], { unit: 'USD', freq: 'quarterly' });
  assert.equal(m.size, 1);
  assert.equal(m.get('2023 Q1').val, 300);
});

test('fundamentals rows carry derived margins, oldest first', () => {
  const rows = extractFundamentals(facts(), 'annual');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].period, 'FY2022');
  assert.equal(rows[1].period, 'FY2023');

  const fy23 = rows[1];
  assert.equal(fy23.revenue, 1250);
  assert.equal(fy23.grossProfit, 500);
  assert.equal(fy23.netIncome, 150);
  assert.equal(fy23.epsDiluted, 1.5);
  assert.ok(Math.abs(fy23.grossMargin - 500 / 1250) < 1e-9);
  assert.ok(Math.abs(fy23.netMargin - 150 / 1250) < 1e-9);

  // FY2022 tagged no gross profit → its gross margin is null, not zero.
  assert.equal(rows[0].grossMargin, null);
  assert.ok(Math.abs(rows[0].netMargin - 100 / 1000) < 1e-9);
});
