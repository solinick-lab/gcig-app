import { test } from 'node:test';
import assert from 'node:assert/strict';

import { utcIsoToEtInputValue, etInputValueToUtcIso } from './etDateTime.js';

// The user-reported bug, verbatim. A pitch stored as
// 2026-05-13T17:50Z must surface in the datetime-local input as the
// New-York wall clock (1:50 PM EDT), not the raw UTC digits. The old
// code did `.toISOString().slice(0,16)` and showed 17:50, four hours
// in the future, then re-encoded that as if it were local and drifted
// the stored instant on every save.
test('utcIsoToEtInputValue — the reported 2026-05-13 EDT case', () => {
  assert.equal(
    utcIsoToEtInputValue('2026-05-13T17:50:00.000Z'),
    '2026-05-13T13:50'
  );
});

test('etInputValueToUtcIso — inverse of the reported case (EDT, -4h)', () => {
  assert.equal(
    etInputValueToUtcIso('2026-05-13T13:50'),
    '2026-05-13T17:50:00.000Z'
  );
});

// January is EST (-5h), so the same pair must shift by five hours and
// still round-trip. This is the half the offset-derivation has to get
// right without a tz library.
test('utcIsoToEtInputValue — winter EST case', () => {
  assert.equal(
    utcIsoToEtInputValue('2026-01-15T18:30:00.000Z'),
    '2026-01-15T13:30'
  );
});

test('etInputValueToUtcIso — winter EST inverse (-5h)', () => {
  assert.equal(
    etInputValueToUtcIso('2026-01-15T13:30'),
    '2026-01-15T18:30:00.000Z'
  );
});

// The whole point of the fix: the two functions are exact inverses,
// so an unchanged edit -> save no longer moves the stored instant.
// Span both DST regimes plus midnight (the Intl hour:'24' quirk) and
// a sub-hour offset year boundary.
test('round-trip identity across EDT and EST instants', () => {
  const instants = [
    '2026-05-13T17:50:00.000Z',
    '2026-01-15T18:30:00.000Z',
    '2026-07-04T00:00:00.000Z',
    '2026-12-31T23:59:00.000Z',
    '2026-03-15T12:00:00.000Z',
    '2026-11-01T09:15:00.000Z',
  ];
  for (const z of instants) {
    assert.equal(
      etInputValueToUtcIso(utcIsoToEtInputValue(z)),
      z,
      `round trip failed for ${z}`
    );
  }
});

test('utcIsoToEtInputValue accepts a Date as well as a string', () => {
  assert.equal(
    utcIsoToEtInputValue(new Date('2026-05-13T17:50:00.000Z')),
    '2026-05-13T13:50'
  );
});

// Never throw on junk — populate runs on whatever the API returns and
// save runs on whatever is in the form. Bad input degrades to a
// falsy value the caller can handle, it does not blow up the page.
test('utcIsoToEtInputValue is total — junk yields empty string', () => {
  assert.equal(utcIsoToEtInputValue(''), '');
  assert.equal(utcIsoToEtInputValue(null), '');
  assert.equal(utcIsoToEtInputValue(undefined), '');
  assert.equal(utcIsoToEtInputValue('garbage'), '');
  assert.equal(utcIsoToEtInputValue(Number.NaN), '');
});

test('etInputValueToUtcIso is total — junk yields null', () => {
  assert.equal(etInputValueToUtcIso(''), null);
  assert.equal(etInputValueToUtcIso(null), null);
  assert.equal(etInputValueToUtcIso(undefined), null);
  assert.equal(etInputValueToUtcIso('garbage'), null);
  assert.equal(etInputValueToUtcIso(42), null);
});
