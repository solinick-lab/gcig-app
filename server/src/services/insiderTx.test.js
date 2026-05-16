import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCode, normalizeFinnhub, parseForm4Xml, roleFromRelationship, getInsiderTransactions, _resetInsiderCache } from './insiderTx.js';

test('classifyCode flags only open-market P and S', () => {
  assert.deepEqual(classifyCode('P'), { isBuy: true, isSell: false });
  assert.deepEqual(classifyCode('S'), { isBuy: false, isSell: true });
  for (const c of ['A', 'M', 'F', 'G', 'D', '', null, undefined]) {
    assert.deepEqual(classifyCode(c), { isBuy: false, isSell: false });
  }
});

test('normalizeFinnhub maps rows, derives value, sorts date-desc', () => {
  const rows = normalizeFinnhub([
    { name: 'Old Buyer', transactionDate: '2025-01-02', transactionCode: 'P', change: 100, transactionPrice: 10 },
    { name: 'New Seller', transactionDate: '2026-03-04', transactionCode: 'S', change: -50, transactionPrice: 20 },
    { name: 'No Price', transactionDate: '2026-02-01', transactionCode: 'P', change: 5, transactionPrice: 0 },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'New Seller');
  assert.equal(rows[0].isSell, true);
  assert.equal(rows[0].shares, 50);
  assert.equal(rows[0].value, 1000);
  assert.equal(rows[2].name, 'Old Buyer');
  assert.equal(rows[2].isBuy, true);
  const noPrice = rows.find((r) => r.name === 'No Price');
  assert.equal(noPrice.value, null);
  assert.equal(noPrice.shares, 5);
  assert.equal(rows[0].role, null);
});

test('normalizeFinnhub tolerates empty / non-array', () => {
  assert.deepEqual(normalizeFinnhub(null), []);
  assert.deepEqual(normalizeFinnhub(undefined), []);
  assert.deepEqual(normalizeFinnhub([]), []);
});

test('normalizeFinnhub falls back to filingDate when transactionDate absent', () => {
  const [row] = normalizeFinnhub([
    { name: 'X', transactionCode: 'P', change: 1, transactionPrice: 5, filingDate: '2025-06-01' },
  ]);
  assert.equal(row.date, '2025-06-01');
});

const FORM4_FIXTURE = `<?xml version="1.0"?>
<ownershipDocument>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Huang Jen-Hsun</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <officerTitle>President and CEO</officerTitle>
      <isTenPercentOwner>0</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-14</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100000</value></transactionShares>
        <transactionPricePerShare><value>123.45</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2000</value></transactionShares>
        <transactionPricePerShare><value>120.00</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

test('roleFromRelationship prefers officer title, then director, then 10%', () => {
  assert.equal(
    roleFromRelationship('<isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CFO</officerTitle>'),
    'CFO'
  );
  assert.equal(roleFromRelationship('<isDirector>1</isDirector><isOfficer>0</isOfficer>'), 'Director');
  assert.equal(roleFromRelationship('<isTenPercentOwner>1</isTenPercentOwner>'), '10% Owner');
  assert.equal(roleFromRelationship('<isOfficer>1</isOfficer>'), 'Officer');
  assert.equal(roleFromRelationship(''), null);
});

test('parseForm4Xml extracts owner, role, and each transaction', () => {
  const rows = parseForm4Xml(FORM4_FIXTURE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Huang Jen-Hsun');
  assert.equal(rows[0].role, 'President and CEO');
  assert.equal(rows[0].date, '2026-05-14');
  assert.equal(rows[0].code, 'S');
  assert.equal(rows[0].isSell, true);
  assert.equal(rows[0].shares, 100000);
  assert.equal(rows[0].price, 123.45);
  assert.equal(rows[0].value, 12345000);
  assert.equal(rows[1].code, 'P');
  assert.equal(rows[1].isBuy, true);
});

test('parseForm4Xml returns [] on garbage', () => {
  assert.deepEqual(parseForm4Xml('not xml'), []);
  assert.deepEqual(parseForm4Xml(''), []);
});

test('parseForm4Xml returns rows newest-first', () => {
  const rows = parseForm4Xml(FORM4_FIXTURE);
  assert.equal(rows[0].date, '2026-05-14');
  assert.equal(rows[1].date, '2026-05-13');
  assert.ok(new Date(rows[0].date) >= new Date(rows[1].date));
});

test('getInsiderTransactions returns Finnhub data when present', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => [
      { name: 'A', transactionDate: '2026-05-01', transactionCode: 'P', change: 10, transactionPrice: 5 },
    ],
    secFetch: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res._source, 'finnhub');
  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].name, 'A');
});

test('getInsiderTransactions falls back to SEC when Finnhub empty', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => [],
    secFetch: async () => [
      { date: '2026-04-01', name: 'B', role: 'CEO', code: 'S', isBuy: false, isSell: true, shares: 1, price: 2, value: 2 },
    ],
  });
  assert.equal(res._source, 'sec');
  assert.equal(res.transactions[0].name, 'B');
});

test('getInsiderTransactions returns empty (never throws) when both fail', async () => {
  _resetInsiderCache();
  const res = await getInsiderTransactions('NVDA', {
    finnhubFetch: async () => { throw new Error('finnhub down'); },
    secFetch: async () => { throw new Error('sec down'); },
  });
  assert.equal(res._source, null);
  assert.deepEqual(res.transactions, []);
});

test('getInsiderTransactions caches within TTL', async () => {
  _resetInsiderCache();
  let calls = 0;
  const opts = {
    finnhubFetch: async () => { calls++; return [{ name: 'C', transactionDate: '2026-01-01', transactionCode: 'P', change: 1, transactionPrice: 1 }]; },
    secFetch: async () => [],
  };
  await getInsiderTransactions('AAPL', opts);
  await getInsiderTransactions('AAPL', opts);
  assert.equal(calls, 1);
});
