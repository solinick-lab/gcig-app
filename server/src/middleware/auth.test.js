import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isSuperAdminEmail } from './auth.js';

const ORIGINAL = process.env.SUPER_ADMIN_EMAIL;

beforeEach(() => {
  delete process.env.SUPER_ADMIN_EMAIL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SUPER_ADMIN_EMAIL;
  else process.env.SUPER_ADMIN_EMAIL = ORIGINAL;
});

test('returns false for any email when SUPER_ADMIN_EMAIL is unset', () => {
  assert.equal(isSuperAdminEmail('anyone@example.com'), false);
  assert.equal(isSuperAdminEmail('solinick@gcschool.org'), false);
});

test('returns false for empty/nullish input', () => {
  assert.equal(isSuperAdminEmail(''), false);
  assert.equal(isSuperAdminEmail(null), false);
  assert.equal(isSuperAdminEmail(undefined), false);
});

test('returns true only for emails listed in SUPER_ADMIN_EMAIL', () => {
  process.env.SUPER_ADMIN_EMAIL = 'owner@gcschool.org';
  assert.equal(isSuperAdminEmail('owner@gcschool.org'), true);
  assert.equal(isSuperAdminEmail('someone-else@gcschool.org'), false);
});

test('comma-separated list is honored, case- and whitespace-insensitive', () => {
  process.env.SUPER_ADMIN_EMAIL = 'a@example.com, B@Example.com ,c@example.com';
  assert.equal(isSuperAdminEmail('a@example.com'), true);
  assert.equal(isSuperAdminEmail('  B@example.com  '), true);
  assert.equal(isSuperAdminEmail('C@EXAMPLE.COM'), true);
  assert.equal(isSuperAdminEmail('d@example.com'), false);
});
