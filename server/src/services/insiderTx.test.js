import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCode, normalizeFinnhub } from './insiderTx.js';

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
  assert.equal(rows[1].value, null);
  assert.equal(rows[0].role, null);
});

test('normalizeFinnhub tolerates empty / non-array', () => {
  assert.deepEqual(normalizeFinnhub(null), []);
  assert.deepEqual(normalizeFinnhub(undefined), []);
  assert.deepEqual(normalizeFinnhub([]), []);
});
