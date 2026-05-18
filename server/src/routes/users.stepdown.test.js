import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepDownHandler } from './users.js';

// The repo has no route-test/HTTP harness; every suite drives the unit
// directly with injected deps and never touches the DB (see
// terminal.execbios.test.js). stepDownHandler is exported for exactly
// that: a fake req/res plus an injected `db` (Prisma double) and `audit`.

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

// Prisma double. `findUnique` returns the seeded user (or null); `update`
// records the args it was called with and echoes a plausible row.
function fakeDb(user) {
  const calls = { update: null };
  return {
    calls,
    user: {
      async findUnique() {
        return user;
      },
      async update(args) {
        calls.update = args;
        return {
          id: args.where.id,
          name: user?.name ?? 'X',
          email: user?.email ?? 'x@example.com',
          role: args.data.role,
          extraRoles: args.data.extraRoles,
        };
      },
    },
  };
}

function makeAuditSpy() {
  const spy = { called: false, action: null };
  return {
    spy,
    audit: async (_req, action) => {
      spy.called = true;
      spy.action = action;
    },
  };
}

test('President steps down: role → JuniorAnalyst, FormerPresident badge added, audited', async () => {
  const db = fakeDb({
    id: 7,
    name: 'Jordan',
    email: 'jordan@gcschool.org',
    role: 'President',
    extraRoles: [],
  });
  const { spy, audit } = makeAuditSpy();
  const res = fakeRes();

  await stepDownHandler({ params: { id: '7' } }, res, { db, audit });

  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.update.data.role, 'JuniorAnalyst');
  assert.deepEqual(db.calls.update.data.extraRoles, ['FormerPresident']);
  assert.equal(res.body.role, 'JuniorAnalyst');
  assert.ok(res.body.extraRoles.includes('FormerPresident'));
  assert.equal(spy.called, true);
  assert.equal(spy.action, 'user.stepped_down');
});

test('existing extraRoles are preserved and the badge is de-duplicated', async () => {
  const db = fakeDb({
    id: 3,
    role: 'President',
    extraRoles: ['ChiefOfCommunication', 'FormerPresident'],
  });
  const { audit } = makeAuditSpy();
  const res = fakeRes();

  await stepDownHandler({ params: { id: '3' } }, res, { db, audit });

  const er = db.calls.update.data.extraRoles;
  assert.deepEqual(er, ['ChiefOfCommunication', 'FormerPresident']);
  assert.equal(er.filter((r) => r === 'FormerPresident').length, 1);
});

test('404 when the target does not exist (no write, no audit)', async () => {
  const db = fakeDb(null);
  const { spy, audit } = makeAuditSpy();
  const res = fakeRes();

  await stepDownHandler({ params: { id: '99' } }, res, { db, audit });

  assert.equal(res.statusCode, 404);
  assert.equal(db.calls.update, null);
  assert.equal(spy.called, false);
});

test('400 when the target is not currently a President', async () => {
  const db = fakeDb({ id: 5, role: 'CIO', extraRoles: [] });
  const { spy, audit } = makeAuditSpy();
  const res = fakeRes();

  await stepDownHandler({ params: { id: '5' } }, res, { db, audit });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /sitting President/i);
  assert.equal(db.calls.update, null);
  assert.equal(spy.called, false);
});

test('400 on a non-numeric id', async () => {
  const db = fakeDb({ id: 1, role: 'President', extraRoles: [] });
  const { audit } = makeAuditSpy();
  const res = fakeRes();

  await stepDownHandler({ params: { id: 'abc' } }, res, { db, audit });

  assert.equal(res.statusCode, 400);
  assert.equal(db.calls.update, null);
});
