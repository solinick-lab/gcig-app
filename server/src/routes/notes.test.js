import { test } from 'node:test';
import assert from 'node:assert/strict';
import router, {
  getNoteHandler,
  putNoteHandler,
  deleteNoteHandler,
} from './notes.js';

// The repo carries no route-test/HTTP harness or supertest; every suite
// drives the exported handler directly with a fake req/res and an
// injected Prisma double, never the network or a database (the same
// precedent users.stepdown.test.js / the terminal route suites follow).
// NOTE's handlers take a `deps.db` Prisma stand-in for exactly that —
// these tests need no Postgres.
//
// The load-bearing invariant under test is per-user isolation: every
// read, write and delete the route issues MUST be scoped by
// userId:req.user.id, so a caller can never see or mutate another
// user's note via the (userId,ticker) unique key. Each stub records the
// args it was handed so we can assert that scoping at the query level.

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

// Prisma double for the researchNote model. Records the args every
// method was called with; `findUnique`/`findFirst` resolve to the
// seeded row (or null), `upsert` echoes a plausible saved row, and
// `deleteMany` reports a count. A `note` of null seeds "no note yet".
function fakeDb(note, opts = {}) {
  const calls = {
    findUnique: null,
    findFirst: null,
    upsert: null,
    deleteMany: null,
  };
  return {
    calls,
    researchNote: {
      async findUnique(args) {
        calls.findUnique = args;
        if (opts.throwOnRead) throw new Error('db down');
        return note;
      },
      async findFirst(args) {
        calls.findFirst = args;
        if (opts.throwOnRead) throw new Error('db down');
        return note;
      },
      async upsert(args) {
        calls.upsert = args;
        if (opts.throwOnWrite) throw new Error('db down');
        return {
          ticker: args.create.ticker,
          body: args.update.body,
          updatedAt: new Date('2026-05-18T12:00:00.000Z'),
        };
      },
      async deleteMany(args) {
        calls.deleteMany = args;
        if (opts.throwOnWrite) throw new Error('db down');
        return { count: note ? 1 : 0 };
      },
    },
  };
}

// A read for a ticker the user has never noted is an honest empty
// 200 — { ticker, body:'', updatedAt:null } — never a 404. The read
// the route issues MUST carry userId:req.user.id alongside the ticker.
test('GET /:ticker: 200 honest-empty when the user has no note, scoped by userId', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await getNoteHandler(
    { params: { ticker: 'aapl' }, user: { id: 42 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'AAPL', body: '', updatedAt: null });
  const whereArgs = db.calls.findUnique || db.calls.findFirst;
  assert.ok(whereArgs, 'a read query must have been issued');
  // The scoping invariant: ticker uppercased AND hard-bound to the
  // caller's own id — never a bare ticker lookup.
  assert.equal(whereArgs.where.userId_ticker?.userId ?? whereArgs.where.userId, 42);
  assert.equal(
    whereArgs.where.userId_ticker?.ticker ?? whereArgs.where.ticker,
    'AAPL'
  );
});

// An existing note comes back as { ticker, body, updatedAt }. The
// ticker is upper-cased before it reaches the query and the lookup is
// still scoped to the caller.
test('GET /:ticker: returns the stored note for the owning user', async () => {
  const db = fakeDb({
    ticker: 'MSFT',
    body: 'cloud thesis intact',
    updatedAt: new Date('2026-05-17T09:00:00.000Z'),
  });
  const res = fakeRes();
  await getNoteHandler(
    { params: { ticker: 'msft' }, user: { id: 7 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'MSFT');
  assert.equal(res.body.body, 'cloud thesis intact');
  assert.ok(res.body.updatedAt);
  const whereArgs = db.calls.findUnique || db.calls.findFirst;
  assert.equal(whereArgs.where.userId_ticker?.userId ?? whereArgs.where.userId, 7);
});

// Cross-user isolation, stated as an explicit test: the seeded note
// belongs to user 7, but user 99 asking for the same ticker must have
// its read scoped to id 99 (the stub would, in a real DB, then miss).
// Proves the route can never be tricked into reading another user's
// note by ticker alone.
test('GET /:ticker: a different user cannot read someone else\'s note (read is id-scoped)', async () => {
  const db = fakeDb(null); // a real DB would find nothing for user 99
  const res = fakeRes();
  await getNoteHandler(
    { params: { ticker: 'NVDA' }, user: { id: 99 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'NVDA', body: '', updatedAt: null });
  const whereArgs = db.calls.findUnique || db.calls.findFirst;
  assert.equal(whereArgs.where.userId_ticker?.userId ?? whereArgs.where.userId, 99);
  assert.notEqual(whereArgs.where.userId_ticker?.userId ?? whereArgs.where.userId, 7);
});

// A malformed ticker is the one acceptable non-200 — it mirrors the
// terminal route input guard exactly (/^[A-Z0-9.\-]{1,12}$/ → 400
// 'Invalid ticker'). No query is issued.
test('GET /:ticker: 400 on an invalid ticker, no query issued', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await getNoteHandler(
    { params: { ticker: 'not a ticker!!' }, user: { id: 1 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(db.calls.findUnique, null);
  assert.equal(db.calls.findFirst, null);
});

// PUT with a real body upserts on the (userId,ticker) unique key and
// returns the saved { ticker, body, updatedAt }. The upsert MUST carry
// userId:req.user.id in both the where-key and the create payload, so a
// write can only ever land on the caller's own row.
test('PUT /:ticker: upserts the note, scoped by userId, returns the saved row', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await putNoteHandler(
    {
      params: { ticker: 'aapl' },
      user: { id: 42 },
      body: { body: '  buy the dip — fundamentals strong  ' },
    },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, 'AAPL');
  assert.equal(res.body.body, 'buy the dip — fundamentals strong'); // trimmed
  assert.ok(res.body.updatedAt);
  const up = db.calls.upsert;
  assert.ok(up, 'upsert must have been called');
  assert.equal(up.where.userId_ticker.userId, 42);
  assert.equal(up.where.userId_ticker.ticker, 'AAPL');
  assert.equal(up.create.userId, 42);
  assert.equal(up.create.ticker, 'AAPL');
  assert.equal(up.create.body, 'buy the dip — fundamentals strong');
  assert.equal(up.update.body, 'buy the dip — fundamentals strong');
  // A write must never touch deleteMany on the save path.
  assert.equal(db.calls.deleteMany, null);
});

// Idempotency: issuing the same PUT twice produces the same upsert
// shape both times (upsert is inherently idempotent on the unique key —
// the second call updates rather than duplicating). We assert the
// handler keeps calling upsert (never insert) so re-saving is safe.
test('PUT /:ticker: re-saving the same body is idempotent (always upsert on the unique key)', async () => {
  const db = fakeDb({
    ticker: 'AAPL',
    body: 'thesis v1',
    updatedAt: new Date('2026-05-17T00:00:00.000Z'),
  });
  const first = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 5 }, body: { body: 'thesis v1' } },
    first,
    { db }
  );
  const firstUpsert = db.calls.upsert;
  const second = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 5 }, body: { body: 'thesis v1' } },
    second,
    { db }
  );
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(
    firstUpsert.where.userId_ticker,
    db.calls.upsert.where.userId_ticker,
    'same unique key both times'
  );
  assert.equal(db.calls.upsert.create.userId, 5);
});

// Body cap: an over-long body is capped to 10000 characters before it
// is persisted (the spec says cap, not reject). The stored string the
// upsert receives is exactly 10000 chars.
test('PUT /:ticker: a body over 10000 chars is capped to 10000 before persisting', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  const huge = 'x'.repeat(15000);
  await putNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 1 }, body: { body: huge } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(db.calls.upsert.create.body.length, 10000);
  assert.equal(db.calls.upsert.update.body.length, 10000);
  assert.equal(res.body.body.length, 10000);
});

// An empty / whitespace-only PUT body is the "clear + save" path: the
// note is DELETED (deleteMany scoped to userId+ticker) and the response
// is the same honest-empty shape. No upsert of a blank row.
test('PUT /:ticker: an empty/whitespace body deletes the note (clear path), id-scoped', async () => {
  const db = fakeDb({
    ticker: 'AAPL',
    body: 'old',
    updatedAt: new Date('2026-05-17T00:00:00.000Z'),
  });
  const res = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'aapl' }, user: { id: 42 }, body: { body: '   \n  ' } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'AAPL', body: '', updatedAt: null });
  assert.ok(db.calls.deleteMany, 'empty body must take the delete path');
  assert.equal(db.calls.deleteMany.where.userId, 42);
  assert.equal(db.calls.deleteMany.where.ticker, 'AAPL');
  assert.equal(db.calls.upsert, null, 'must not upsert a blank row');
});

// PUT with a missing body field is treated the same as empty — delete
// path, honest-empty 200 (the client's Clear button sends {} or
// { body:'' } interchangeably).
test('PUT /:ticker: a missing body field is treated as clear (delete), not a 400', async () => {
  const db = fakeDb({ ticker: 'AAPL', body: 'old', updatedAt: new Date() });
  const res = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 8 }, body: {} },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'AAPL', body: '', updatedAt: null });
  assert.ok(db.calls.deleteMany);
  assert.equal(db.calls.deleteMany.where.userId, 8);
});

// PUT input guard: a malformed ticker 400s before any DB work, same as
// GET and the terminal sibling routes.
test('PUT /:ticker: 400 on an invalid ticker, no DB work', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'bad ticker!' }, user: { id: 1 }, body: { body: 'x' } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(db.calls.upsert, null);
  assert.equal(db.calls.deleteMany, null);
});

// DELETE removes the caller's note for the ticker (deleteMany scoped to
// userId+ticker) and returns the honest-empty shape.
test('DELETE /:ticker: deletes the caller\'s note, id-scoped, returns empty', async () => {
  const db = fakeDb({ ticker: 'AAPL', body: 'x', updatedAt: new Date() });
  const res = fakeRes();
  await deleteNoteHandler(
    { params: { ticker: 'aapl' }, user: { id: 42 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'AAPL', body: '', updatedAt: null });
  assert.ok(db.calls.deleteMany);
  assert.equal(db.calls.deleteMany.where.userId, 42);
  assert.equal(db.calls.deleteMany.where.ticker, 'AAPL');
});

// Deleting a note that does not exist is a no-op success — deleteMany
// matches zero rows, the response is still the honest-empty 200. A user
// hitting Clear on an empty note must not error.
test('DELETE /:ticker: absent note is a no-op success (not a 404)', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await deleteNoteHandler(
    { params: { ticker: 'TSLA' }, user: { id: 3 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'TSLA', body: '', updatedAt: null });
  assert.ok(db.calls.deleteMany);
  assert.equal(db.calls.deleteMany.where.userId, 3);
});

// DELETE input guard mirrors GET/PUT.
test('DELETE /:ticker: 400 on an invalid ticker, no DB work', async () => {
  const db = fakeDb(null);
  const res = fakeRes();
  await deleteNoteHandler(
    { params: { ticker: '!!' }, user: { id: 1 } },
    res,
    { db }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'Invalid ticker');
  assert.equal(db.calls.deleteMany, null);
});

// Never-5xx: the route does not lean on Prisma being up. A read that
// rejects degrades to the honest-empty 200, not a 500 — the panel says
// "couldn't load" rather than erroring the terminal.
test('GET /:ticker: a DB rejection degrades to honest-empty 200, never 5xx', async () => {
  const db = fakeDb(null, { throwOnRead: true });
  const res = fakeRes();
  await getNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 1 } },
    res,
    { db }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ticker: 'AAPL', body: '', updatedAt: null });
});

// A failed write must NOT 5xx either — it returns a 4xx the client can
// surface ("couldn't save") while the client keeps the user's text. The
// contract is simply: never a 500.
test('PUT /:ticker: a DB write rejection never 5xx (client keeps text, shows error)', async () => {
  const db = fakeDb(null, { throwOnWrite: true });
  const res = fakeRes();
  await putNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 1 }, body: { body: 'thesis' } },
    res,
    { db }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
});

// A failed delete likewise never 5xx.
test('DELETE /:ticker: a DB rejection never 5xx', async () => {
  const db = fakeDb({ ticker: 'AAPL', body: 'x', updatedAt: new Date() }, {
    throwOnWrite: true,
  });
  const res = fakeRes();
  await deleteNoteHandler(
    { params: { ticker: 'AAPL' }, user: { id: 1 } },
    res,
    { db }
  );
  assert.ok(res.statusCode < 500, `must not 5xx, got ${res.statusCode}`);
});

// Auth parity, by the same structural technique the terminal route
// suites use: verifyJwt must be a global middleware on the notes
// router (it is the only thing standing between an anonymous caller
// and another member's private notes), and the three CRUD routes must
// each carry exactly one handler — no per-route auth divergence, the
// gate is global like presidentReview.js.
test('notes router mounts verifyJwt globally and the CRUD routes carry one handler each', () => {
  const layers = router.stack;

  const globalMw = layers
    .filter((l) => !l.route && typeof l.handle === 'function')
    .map((l) => l.handle.name);
  assert.ok(
    globalMw.includes('verifyJwt'),
    'verifyJwt must be a global middleware on the notes router'
  );

  const findRoute = (p, method) =>
    layers.find(
      (l) =>
        l.route &&
        l.route.path === p &&
        l.route.stack.some((s) => s.method === method)
    );
  const get = findRoute('/:ticker', 'get');
  const put = findRoute('/:ticker', 'put');
  const del = findRoute('/:ticker', 'delete');
  assert.ok(get, 'GET /:ticker must be registered');
  assert.ok(put, 'PUT /:ticker must be registered');
  assert.ok(del, 'DELETE /:ticker must be registered');

  const handlerCount = (layer, method) =>
    layer.route.stack.filter((s) => s.method === method).length;
  assert.equal(handlerCount(get, 'get'), 1, 'GET has exactly one handler');
  assert.equal(handlerCount(put, 'put'), 1, 'PUT has exactly one handler');
  assert.equal(
    handlerCount(del, 'delete'),
    1,
    'DELETE has exactly one handler'
  );
});
