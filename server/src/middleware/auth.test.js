import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSuperAdminEmail,
  ROLE_RANK,
  requireRole,
  requireExecutive,
  requireAdmin,
} from './auth.js';

// Minimal Express test doubles, matching the dependency-injection /
// fake-req-res precedent in routes/terminal.execbios.test.js. No DB,
// no network.
function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}
function runGate(gate, user) {
  const res = fakeRes();
  let nextCalled = false;
  gate({ user }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

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

// ─── FormerPresident is a no-power honorific ───────────────────────────
// A former president's *primary* role is JuniorAnalyst; FormerPresident
// only ever appears as an extraRoles badge. As defense in depth, the
// FormerPresident role itself is ranked 0 so it confers nothing even if
// it were ever mis-set as a primary role.

test('ROLE_RANK ranks FormerPresident at 0 (below every operational role)', () => {
  assert.equal(ROLE_RANK.FormerPresident, 0);
  assert.ok(ROLE_RANK.FormerPresident < ROLE_RANK.JuniorAnalyst);
  assert.ok(ROLE_RANK.FormerPresident < ROLE_RANK.AdvisoryBoardMember);
});

test('requireRole denies a FormerPresident the JuniorAnalyst tier', () => {
  const gate = requireRole('JuniorAnalyst');
  const { res, nextCalled } = runGate(gate, { role: 'FormerPresident' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireExecutive denies a FormerPresident', () => {
  const { res, nextCalled } = runGate(requireExecutive, {
    role: 'FormerPresident',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('requireAdmin denies a FormerPresident', () => {
  const { res, nextCalled } = runGate(requireAdmin, {
    role: 'FormerPresident',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
