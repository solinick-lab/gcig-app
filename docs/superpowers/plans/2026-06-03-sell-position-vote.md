# Sell-the-Position Vote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second voting-session kind — a vote to exit an existing holding (Sell/Hold, no recommended amount), opened against a real position, that feeds the existing Trade Requests → DocuSign flow when it passes.

**Architecture:** One `VotingSession.kind` discriminator (`"buy"` | `"sell"`) reuses the whole pipeline — ballots, weighted `computeTally` (unchanged, so weighting is identical), lazy close, AI recap, DocuSign linkage. Sell sessions differ only in allowed ballot actions (Sell/Hold), the create form (position picker, no allocation), the recap prompt, and a new `eligible-sells` path into the bundled trade composer. Logic that needs tests is extracted into pure, DB-free helpers (the repo's test pattern — no HTTP/DB harness).

**Tech Stack:** Node + Express + Prisma (PostgreSQL), React 18 + Vite + Tailwind. Server tests via `node --test` (colocated `*.test.js`), client validated via `npm run build`.

**Spec:** `docs/superpowers/specs/2026-06-03-sell-position-vote-design.md`

---

## API contract (all tasks align to this)

- `POST /api/votes` body `{ ticker, title?, pitchId?, deadline, kind? }`. `kind` defaults `"buy"`; `"sell"` forces `pitchId` null. Response carries `kind`.
- `POST /api/votes/:id/ballot` body `{ action, note?, investmentAmount? }`. For a `"sell"` session: `action ∈ {Sell,Hold}` (Buy → 400), `investmentAmount` always null. For `"buy"`: unchanged (Buy/Hold/Sell; Buy needs $1,500–$10,000).
- `GET /api/votes`, `/votes/:id`, `/votes/pending` include the scalar `kind`.
- `GET /api/trade-requests/eligible-sells` (exec) → `[{ id, ticker, title, closedAt, createdAt, creator, heldShares, ballotCount }]`: closed `kind:"sell"` sessions whose `finalDecision === "Sell"`, not yet claimed by a Sell `TradeRequestItem`, annotated with `heldShares` from the portfolio sheet (`null` if unavailable).
- `POST /api/trade-requests` — a `Sell` item may carry `votingSessionId`. When present the server validates the session is closed, `kind:"sell"`, `finalDecision:"Sell"`; sets `ticker` from the session; defaults `shares` to the held position (sheet) unless `shares` is given; links the item.
- Pitch-outcome inference (`pitches.js`, `users.js`) restricts its closed-session lookup to `kind:"buy"`.

---

## Task 1: Schema — add `VotingSession.kind`

**Files:**
- Modify: `server/prisma/schema.prisma:262`
- Create (generated): `server/prisma/migrations/<ts>_add_voting_session_kind/migration.sql`

- [ ] **Step 1: Add the field.** In `model VotingSession`, immediately after the `status` line (`server/prisma/schema.prisma:262`), insert:

```prisma
  status     String    @default("open")
  // "buy"  → a pitch vote (Buy/Hold/Sell, proposed allocation).
  // "sell" → a vote to exit a holding we own (Sell/Hold, no amount).
  kind       String    @default("buy")
```

- [ ] **Step 2: Generate the migration + client.** The local DB (`localhost:5432/gcig`) is two committed migrations behind; `migrate dev` applies those first, then creates ours.

Run: `cd server && npx prisma migrate dev --name add_voting_session_kind`
Expected: applies `add_former_president_role` + `add_research_notes`, then creates `add_voting_session_kind` whose SQL is `ALTER TABLE "VotingSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'buy';`. Prisma Client regenerates. (If it reports drift and wants a reset, stop and hand-author the migration SQL file instead, matching the convention in existing `migration.sql` files — do not reset the dev DB.)

- [ ] **Step 3: Verify the SQL.** Run: `cat server/prisma/migrations/*add_voting_session_kind*/migration.sql`
Expected: the single `ALTER TABLE ... ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'buy';`.

- [ ] **Step 4: Commit.**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat: add VotingSession.kind discriminator (buy | sell)"
```

---

## Task 2: votes.js — kind-aware create + ballot (pure helpers + tests)

**Files:**
- Modify: `server/src/routes/votes.js` (create handler ~186, ballot handler ~216)
- Test: `server/src/routes/votes.kind.test.js` (new)

- [ ] **Step 1: Write the failing test.** Create `server/src/routes/votes.kind.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionKind, prepareBallot, computeTally } from './votes.js';

test('resolveSessionKind defaults to buy and rejects junk', () => {
  assert.equal(resolveSessionKind(undefined), 'buy');
  assert.equal(resolveSessionKind('buy'), 'buy');
  assert.equal(resolveSessionKind('sell'), 'sell');
  assert.equal(resolveSessionKind('SELL'), 'sell');
  assert.equal(resolveSessionKind('nonsense'), null);
});

test('prepareBallot — buy session keeps existing Buy/Hold/Sell rules', () => {
  assert.deepEqual(prepareBallot('buy', { action: 'Buy', investmentAmount: 2000 }), {
    action: 'Buy', investmentAmount: 2000,
  });
  assert.deepEqual(prepareBallot('buy', { action: 'Hold', investmentAmount: 5000 }), {
    action: 'Hold', investmentAmount: null,
  });
  assert.equal(prepareBallot('buy', { action: 'Buy', investmentAmount: 100 }).error !== undefined, true);
  assert.equal(prepareBallot('buy', { action: 'Nope' }).error !== undefined, true);
});

test('prepareBallot — sell session allows only Sell/Hold and never an amount', () => {
  assert.deepEqual(prepareBallot('sell', { action: 'Sell', investmentAmount: 9999 }), {
    action: 'Sell', investmentAmount: null,
  });
  assert.deepEqual(prepareBallot('sell', { action: 'Hold' }), {
    action: 'Hold', investmentAmount: null,
  });
  const buyOnSell = prepareBallot('sell', { action: 'Buy', investmentAmount: 2000 });
  assert.equal(buyOnSell.error !== undefined, true);
  assert.match(buyOnSell.error, /Sell or Hold/i);
});

test('computeTally weights a sell session (Sell vs Hold) like a buy vote', () => {
  // 3 general-body Sell, 0 Hold; one leadership Sell. No Buy ballots.
  const users = [
    { id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' },
    { id: 3, role: 'JuniorAnalyst' }, { id: 9, role: 'President' },
  ];
  const ballots = [
    { userId: 1, action: 'Sell', investmentAmount: null },
    { userId: 2, action: 'Sell', investmentAmount: null },
    { userId: 3, action: 'Hold', investmentAmount: null },
    { userId: 9, action: 'Sell', investmentAmount: null },
  ];
  const t = computeTally(ballots, users);
  assert.equal(t.finalDecision, 'Sell');
  assert.equal(t.buyAmountStats, null);
  assert.equal(t.weights.Sell, 4); // general-body bloc (3) + 1 leadership
});
```

- [ ] **Step 2: Run it — expect failure.** Run: `cd server && node --test src/routes/votes.kind.test.js`
Expected: FAIL — `resolveSessionKind`/`prepareBallot` are not exported.

- [ ] **Step 3: Add the helpers + wire the handlers.** In `server/src/routes/votes.js`, just below the `BUY_MIN`/`BUY_MAX` consts (currently lines 212-213), add:

```js
// Resolve the requested session kind. Defaults to "buy"; anything that
// isn't a known kind returns null so the route can 400.
export function resolveSessionKind(raw) {
  const k = String(raw ?? 'buy').toLowerCase();
  return k === 'buy' || k === 'sell' ? k : null;
}

// Validate + normalize a ballot for a session of the given kind. Returns
// { action, investmentAmount } on success or { error } on rejection.
// Buy sessions: Buy/Hold/Sell, Buy carries a $1,500–$10,000 amount.
// Sell sessions: Sell or Hold only, never an amount (we exit the whole
// position; leadership sizes the order downstream).
export function prepareBallot(kind, { action, investmentAmount } = {}) {
  const allowed = kind === 'sell' ? ['Sell', 'Hold'] : ['Buy', 'Hold', 'Sell'];
  if (!action || !allowed.includes(action)) {
    return {
      error:
        kind === 'sell'
          ? 'action must be Sell or Hold'
          : 'action must be Buy, Hold, or Sell',
    };
  }
  if (kind === 'buy' && action === 'Buy') {
    const n = Number(investmentAmount);
    if (!Number.isFinite(n)) {
      return { error: 'Buy ballots require an investment amount' };
    }
    if (n < BUY_MIN || n > BUY_MAX) {
      return { error: `Investment amount must be between $${BUY_MIN} and $${BUY_MAX}` };
    }
    return { action, investmentAmount: Math.round(n) };
  }
  return { action, investmentAmount: null };
}
```

- [ ] **Step 4: Use `resolveSessionKind` in the create handler.** Replace the body of `POST /` (lines 186-209) so it reads `kind`, validates it, and forces `pitchId` null for sell sessions:

```js
router.post('/', requireExecutive, async (req, res) => {
  const { ticker, title, pitchId, deadline, kind: rawKind } = req.body || {};
  if (!ticker || !deadline) {
    return res.status(400).json({ error: 'ticker and deadline required' });
  }
  const kind = resolveSessionKind(rawKind);
  if (!kind) return res.status(400).json({ error: 'kind must be "buy" or "sell"' });
  const deadlineDate = new Date(deadline);
  if (deadlineDate <= new Date()) {
    return res.status(400).json({ error: 'deadline must be in the future' });
  }
  const session = await prisma.votingSession.create({
    data: {
      ticker: ticker.toUpperCase(),
      title: title || null,
      // A sell vote is about a holding, not a pitch — never attach one.
      pitchId: kind === 'buy' && pitchId ? Number(pitchId) : null,
      kind,
      deadline: deadlineDate,
      createdBy: req.user.id,
    },
    include: {
      creator: { select: { id: true, name: true, role: true } },
      pitch: { select: { id: true, ticker: true, pitcherName: true } },
    },
  });
  res.status(201).json(session);
});
```

- [ ] **Step 5: Use `prepareBallot` in the ballot handler.** In `POST /:id/ballot` (lines 216-264), delete the inline action check (219-221) and the amount block (223-238), load the session first, then validate against its kind:

```js
router.post('/:id/ballot', async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = await prisma.votingSession.findUnique({ where: { id: sessionId } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'open' || new Date() > session.deadline) {
    return res.status(400).json({ error: 'Voting is closed for this session' });
  }

  const prepared = prepareBallot(session.kind, req.body || {});
  if (prepared.error) return res.status(400).json({ error: prepared.error });
  const { action, investmentAmount: amount } = prepared;
  const note = req.body?.note;

  const ballot = await prisma.ballot.upsert({
    where: { sessionId_userId: { sessionId, userId: req.user.id } },
    update: { action, note: note || null, investmentAmount: amount, castAt: new Date() },
    create: { sessionId, userId: req.user.id, action, note: note || null, investmentAmount: amount },
    include: { user: { select: { id: true, name: true, role: true } } },
  });
  res.json(ballot);
});
```

- [ ] **Step 6: Run the test — expect pass.** Run: `cd server && node --test src/routes/votes.kind.test.js`
Expected: PASS (4 tests). Then `node --check src/routes/votes.js` → no output.

- [ ] **Step 7: Commit.**

```bash
git add server/src/routes/votes.js server/src/routes/votes.kind.test.js
git commit -m "feat: kind-aware vote create + ballot (sell sessions = Sell/Hold, no amount)"
```

---

## Task 3: articleSummarizer.js — analyst-style sell recap

**Files:**
- Modify: `server/src/services/articleSummarizer.js` (VOTE_SYSTEM_PROMPT ~111, summarizeVoteSession ~119)

- [ ] **Step 1: Add a sell-specific prompt.** After `VOTE_SYSTEM_PROMPT` (ends line 117), add:

```js
const SELL_VOTE_SYSTEM_PROMPT = `You are summarizing the outcome of a closed vote on whether the club should EXIT an existing holding. The only choices were Sell (exit the position) or Hold (keep it). Write 2-3 short sentences (max 70 words total) in the voice of an analyst's sell-decision note:
  - The final call and weighted tally (e.g. "Club voted Sell 4-2 to exit AAPL").
  - Whether leadership (Presidents/CIO) and the general body aligned.
  - Any recurring theme in the notes members left (valuation, thesis broke, better use of capital, risk, etc.).

There is no dollar amount on a sell vote — do not mention an allocation. Plain prose — no bullet points, no headers, no meta-commentary. If ballots are sparse (fewer than 3), return exactly: INSUFFICIENT`;
```

- [ ] **Step 2: Branch the prompt in `summarizeVoteSession`.** Change the `callChat(VOTE_SYSTEM_PROMPT, …)` call (line 141-144) to pick the prompt by kind:

```js
  const out = await callChat(
    session.kind === 'sell' ? SELL_VOTE_SYSTEM_PROMPT : VOTE_SYSTEM_PROMPT,
    `Session:\n${JSON.stringify(payload, null, 2)}`
  );
```

- [ ] **Step 3: Syntax check + commit.** Run: `cd server && node --check src/services/articleSummarizer.js`
Expected: no output.

```bash
git add server/src/services/articleSummarizer.js
git commit -m "feat: analyst-style recap prompt for sell votes"
```

---

## Task 4: Pitch-outcome inference — ignore sell sessions

**Files:**
- Modify: `server/src/routes/pitches.js:324`
- Modify: `server/src/routes/users.js` (the twin closed-session lookup, ~line 323)

- [ ] **Step 1: Scope the `pitches.js` lookup to buy sessions.** In `server/src/routes/pitches.js`, the `prisma.votingSession.findMany` at line 323-330 currently uses `where: { ticker: { in: myTickers }, status: 'closed' }`. Change to:

```js
      const sessions = await prisma.votingSession.findMany({
        where: { ticker: { in: myTickers }, status: 'closed', kind: 'buy' },
        orderBy: { closedAt: 'desc' },
        select: {
          ticker: true,
          ballots: { select: { action: true } },
        },
      });
```

- [ ] **Step 2: Scope the `users.js` twin.** In `server/src/routes/users.js`, find the matching `votingSession.findMany({ where: { ticker: { in: ... }, status: 'closed' } ... })` (~line 323) and add `kind: 'buy'` to its `where` the same way. Confirm with: `grep -n "status: 'closed'" server/src/routes/users.js`.

- [ ] **Step 3: Verify both sites changed.** Run: `grep -rn "status: 'closed'" server/src/routes/pitches.js server/src/routes/users.js`
Expected: every closed-session lookup used for pitch-outcome inference now also has `kind: 'buy'`. (Leave unrelated `status: 'closed'` queries that aren't about pitch outcomes alone — there should be none in these two reducers.)

- [ ] **Step 4: Syntax check + commit.** Run: `cd server && node --check src/routes/pitches.js && node --check src/routes/users.js`

```bash
git add server/src/routes/pitches.js server/src/routes/users.js
git commit -m "fix: pitch-outcome inference ignores sell-vote sessions"
```

---

## Task 5: tradeRequests.js — eligible-sells + Sell-line vote linking

**Files:**
- Modify: `server/src/routes/tradeRequests.js` (new `GET /eligible-sells` near line 171; Sell branch in `POST /` ~line 237)
- Test: `server/src/routes/tradeRequests.sells.test.js` (new)

- [ ] **Step 1: Write the failing test** (pure helpers, no DB):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEligibleSells, resolveSellVoteLine } from './tradeRequests.js';

const users = [
  { id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' },
  { id: 3, role: 'JuniorAnalyst' },
];
const sellSession = (id, ticker, action) => ({
  id, ticker, title: null, kind: 'sell', status: 'closed',
  closedAt: new Date('2026-06-01'), createdAt: new Date('2026-05-30'),
  creator: { id: 9, name: 'Exec' },
  ballots: [
    { userId: 1, action, investmentAmount: null },
    { userId: 2, action, investmentAmount: null },
    { userId: 3, action, investmentAmount: null },
  ],
});

test('buildEligibleSells keeps only unclaimed Sell-majority sell sessions', () => {
  const sessions = [
    sellSession(10, 'AAPL', 'Sell'),  // eligible
    sellSession(11, 'MSFT', 'Hold'),  // not a Sell outcome → excluded
    sellSession(12, 'AIT', 'Sell'),   // claimed → excluded
  ];
  const out = buildEligibleSells({
    sessions,
    claimedIds: new Set([12]),
    allUsers: users,
    heldByTicker: new Map([['AAPL', 120]]),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 10);
  assert.equal(out[0].ticker, 'AAPL');
  assert.equal(out[0].heldShares, 120);
  assert.equal(out[0].ballotCount, 3);
});

test('buildEligibleSells annotates null heldShares when the sheet lacks the ticker', () => {
  const out = buildEligibleSells({
    sessions: [sellSession(10, 'AAPL', 'Sell')],
    claimedIds: new Set(),
    allUsers: users,
    heldByTicker: new Map(),
  });
  assert.equal(out[0].heldShares, null);
});

test('resolveSellVoteLine validates the linked session', () => {
  const ok = resolveSellVoteLine(sellSession(10, 'AAPL', 'Sell'), users);
  assert.deepEqual(ok, { ticker: 'AAPL', votingSessionId: 10 });

  assert.match(resolveSellVoteLine({ ...sellSession(10, 'AAPL', 'Sell'), status: 'open' }, users).error, /closed/i);
  assert.match(resolveSellVoteLine({ ...sellSession(10, 'AAPL', 'Sell'), kind: 'buy' }, users).error, /sell vote/i);
  assert.match(resolveSellVoteLine(sellSession(11, 'MSFT', 'Hold'), users).error, /did not result in Sell/i);
});
```

- [ ] **Step 2: Run it — expect failure.** Run: `cd server && node --test src/routes/tradeRequests.sells.test.js`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Add the exported helpers.** In `server/src/routes/tradeRequests.js`, after the `MAX_ITEMS` const (line 71), add:

```js
// Closed sell-vote sessions that passed (finalDecision "Sell") and aren't
// already on a TradeRequest, annotated with the shares we currently hold so
// the composer can default to selling the whole position. Pure so it's
// unit-testable without a DB or the sheet.
export function buildEligibleSells({ sessions, claimedIds, allUsers, heldByTicker }) {
  const out = [];
  for (const s of sessions) {
    if (s.kind !== 'sell' || claimedIds.has(s.id)) continue;
    const tally = computeTally(s.ballots, allUsers);
    if (tally.finalDecision !== 'Sell') continue;
    out.push({
      id: s.id,
      ticker: s.ticker,
      title: s.title,
      closedAt: s.closedAt,
      createdAt: s.createdAt,
      creator: s.creator,
      heldShares: heldByTicker.get(String(s.ticker).toUpperCase()) ?? null,
      ballotCount: s.ballots.length,
    });
  }
  return out;
}

// Validate a sell-vote session referenced by a Sell trade line. Returns
// { ticker, votingSessionId } or { error }.
export function resolveSellVoteLine(session, allUsers) {
  if (!session) return { error: 'Voting session not found' };
  if (session.status !== 'closed') {
    return { error: `Session ${session.id} (${session.ticker}) isn't closed yet` };
  }
  if (session.kind !== 'sell') {
    return { error: `Session ${session.id} (${session.ticker}) isn't a sell vote` };
  }
  const tally = computeTally(session.ballots, allUsers);
  if (tally.finalDecision !== 'Sell') {
    return { error: `Session ${session.id} (${session.ticker}) did not result in Sell` };
  }
  return { ticker: session.ticker, votingSessionId: session.id };
}
```

- [ ] **Step 4: Add the `GET /eligible-sells` route.** Insert immediately after the `eligible-buys` route (after line 171), before `GET /:id` (so the literal path wins over `/:id`):

```js
// GET /api/trade-requests/eligible-sells — closed sell votes that passed and
// aren't yet on a TradeRequest, each annotated with the shares we hold so the
// composer can pre-size "sell the whole position".
router.get('/eligible-sells', requireExecutive, async (_req, res, next) => {
  try {
    const claimed = await prisma.tradeRequestItem.findMany({
      where: { kind: 'Sell', votingSessionId: { not: null } },
      select: { votingSessionId: true },
    });
    const claimedIds = new Set(claimed.map((c) => c.votingSessionId));

    const sessions = await prisma.votingSession.findMany({
      where: { status: 'closed', kind: 'sell' },
      orderBy: { closedAt: 'desc' },
      include: { ballots: true, creator: { select: { id: true, name: true } } },
    });
    const allUsers = await prisma.user.findMany({
      select: { id: true, name: true, role: true, email: true, extraRoles: true },
    });

    // Best-effort held-share annotation; never block the picker on a flaky sheet.
    const heldByTicker = new Map();
    try {
      const sheet = await getSheetPortfolio();
      for (const h of sheet.holdings || []) {
        if (!h.isCash) heldByTicker.set(String(h.ticker).toUpperCase(), h.shares ?? null);
      }
    } catch {
      /* leave heldShares null */
    }

    res.json(buildEligibleSells({ sessions, claimedIds, allUsers, heldByTicker }));
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Accept `votingSessionId` on Sell lines in `POST /`.** In the item loop, add a Sell-vote branch alongside the existing Buy branch (after the Buy `votingSessionId` block, ~line 279) and a default-sizing fallback. Add `let proposedSellShares = null;` next to `proposedAvg` (line 249), then:

```js
      if (kind === 'Sell' && raw.votingSessionId) {
        const id = Number(raw.votingSessionId);
        const session = await prisma.votingSession.findUnique({
          where: { id },
          include: { ballots: true },
        });
        const allUsers = await prisma.user.findMany({
          select: { id: true, name: true, role: true, email: true, extraRoles: true },
        });
        const resolvedLine = resolveSellVoteLine(session, allUsers);
        if (resolvedLine.error) return res.status(400).json({ error: resolvedLine.error });
        ticker = resolvedLine.ticker;
        votingSessionId = resolvedLine.votingSessionId;
        // Default to selling the whole position from the sheet (exec can override `shares`).
        try {
          const sheet = await getSheetPortfolio();
          const holding = sheet.holdings.find(
            (h) => String(h.ticker || '').toUpperCase() === ticker
          );
          if (holding?.shares > 0) proposedSellShares = Math.round(holding.shares);
        } catch {
          /* fall through; if no explicit shares the sizing check below 400s */
        }
      }
```

Then in the sizing block, add a branch before the final `else` error (after the `proposedAvg` branch, line 313-316):

```js
      } else if (proposedSellShares != null) {
        shares = proposedSellShares;
      } else {
```

- [ ] **Step 6: Run tests + syntax check.** Run: `cd server && node --test src/routes/tradeRequests.sells.test.js && node --check src/routes/tradeRequests.js`
Expected: PASS (3 tests), no syntax errors.

- [ ] **Step 7: Commit.**

```bash
git add server/src/routes/tradeRequests.js server/src/routes/tradeRequests.sells.test.js
git commit -m "feat: eligible-sells + Sell-line vote linking in trade requests"
```

---

## Task 6: Votes.jsx — session-type toggle, position picker, sell ballot UI

**Files:**
- Modify: `client/src/pages/Votes.jsx`

- [ ] **Step 1: Extend `emptyForm` + action metadata.** Replace `emptyForm` (line 46-48) with a kind-aware version and add a sell-action descriptor map after `ACTION_META` (line 29):

```js
function emptyForm() {
  return { kind: 'buy', ticker: '', title: '', pitchId: '', deadline: '' };
}

// Analyst-desk descriptors for the two sell-vote choices.
const SELL_ACTION_DESC = {
  Sell: 'Exit the position',
  Hold: 'Maintain',
};
const SELL_ACTIONS = ['Sell', 'Hold'];
```

- [ ] **Step 2: Load holdings for the picker.** In the `Votes` component, add state + a fetch next to `loadPitches` (after line 67):

```js
  const [holdings, setHoldings] = useState([]);
  async function loadHoldings() {
    try {
      const { data } = await api.get('/holdings/quotes');
      setHoldings((data?.holdings || []).filter((h) => !h.isCash));
    } catch {
      setHoldings([]);
    }
  }
```

Add `loadHoldings();` to the mount `useEffect` (line 69-72).

- [ ] **Step 3: Send `kind` (and skip pitch for sells) in `handleCreateSession`.** Replace the `api.post('/votes', …)` body (lines 83-88):

```js
      await api.post('/votes', {
        kind: form.kind,
        ticker: form.ticker,
        title: form.title || null,
        pitchId: form.kind === 'buy' && form.pitchId ? Number(form.pitchId) : null,
        deadline: etInputValueToUtcIso(form.deadline),
      });
```

- [ ] **Step 4: Add the type toggle + position picker to the modal.** In the create `<Modal>` (lines 192-247), change the title to dynamic and insert a kind toggle at the top of the form, and make the ticker field a holdings dropdown when `kind === 'sell'`. Replace the modal opening tag and the Ticker `<div>` (lines 192-203) with:

```jsx
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.kind === 'sell' ? 'Start Sell Vote' : 'Start Voting Session'} size="md">
        <form onSubmit={handleCreateSession} className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {[
              { k: 'buy', label: 'Buy pitch', hint: 'Rate a new idea' },
              { k: 'sell', label: 'Sell position', hint: 'Exit a holding' },
            ].map((opt) => (
              <button
                key={opt.k}
                type="button"
                onClick={() => setForm({ ...emptyForm(), kind: opt.k })}
                className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                  form.kind === opt.k
                    ? 'border-gold bg-gold-100/40 ring-1 ring-gold'
                    : 'border-navy-100 bg-white hover:bg-navy-50'
                }`}
              >
                <div className="font-semibold text-navy">{opt.label}</div>
                <div className="text-xs text-navy-400">{opt.hint}</div>
              </button>
            ))}
          </div>
          <div>
            <label className="block text-sm font-medium text-navy">
              {form.kind === 'sell' ? 'Position to sell' : 'Ticker'}
            </label>
            {form.kind === 'sell' ? (
              <select
                required
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              >
                <option value="">Select a holding…</option>
                {holdings.map((h) => (
                  <option key={h.ticker} value={String(h.ticker).toUpperCase()}>
                    {String(h.ticker).toUpperCase()}
                    {h.shares != null ? ` — ${h.shares} sh` : ''}
                    {h.marketValue != null ? ` ($${Math.round(h.marketValue).toLocaleString()})` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                required
                value={form.ticker}
                onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })}
                placeholder="AAPL"
                className="mt-1 w-full rounded-lg border border-navy-100 px-3 py-2 text-sm focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold"
              />
            )}
          </div>
```

Then wrap the "Title / Question" placeholder so it adapts, and gate the "Attach Pitch" `<div>` (lines 213-227) behind `{form.kind === 'buy' && ( … )}`. Update the Title placeholder to `form.kind === 'sell' ? 'Time to exit AAPL?' : 'Q2 decision on AAPL'`.

- [ ] **Step 5: Render sell ballot buttons by kind.** In `SessionDetail`, the action grid (lines 447-471) iterates `Object.keys(ACTION_META)` in `grid-cols-3`. Make it kind-aware:

```jsx
              <div className={`grid gap-2 ${session.kind === 'sell' ? 'grid-cols-2' : 'grid-cols-3'}`}>
                {(session.kind === 'sell' ? SELL_ACTIONS : Object.keys(ACTION_META)).map((a) => {
                  const meta = ACTION_META[a];
                  const Icon = meta.icon;
                  const selected = ballotAction === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => { setBallotAction(a); setBallotError(''); }}
                      className={`flex flex-col items-center gap-1 rounded-lg border px-3 py-3 text-sm font-semibold transition ${
                        selected ? `${meta.badge} ring-2` : 'border-navy-100 bg-white text-navy hover:bg-navy-50'
                      }`}
                    >
                      <Icon className="h-5 w-5" />
                      {a}
                      {session.kind === 'sell' && (
                        <span className="text-[10px] font-normal text-navy-400">{SELL_ACTION_DESC[a]}</span>
                      )}
                    </button>
                  );
                })}
              </div>
```

The amount input (line 475 `{ballotAction === 'Buy' && …}`) needs no change — `Buy` is never selectable on a sell session, so it stays hidden.

- [ ] **Step 6: Analyst framing on the detail header (optional copy).** In `SessionDetail`, where the LIVE/CLOSED chip sits next to the ticker (line 378-389), the framing reads fine as-is; no change required. (The page kicker stays "Decisions".)

- [ ] **Step 7: Build.** Run: `cd client && npm run build`
Expected: Vite build succeeds, no JSX errors.

- [ ] **Step 8: Commit.**

```bash
git add client/src/pages/Votes.jsx
git commit -m "feat: sell-vote create form (position picker) + Sell/Hold ballot UI"
```

---

## Task 7: VoteNotification.jsx — kind-aware copy

**Files:**
- Modify: `client/src/components/VoteNotification.jsx`

- [ ] **Step 1: Branch icon + copy on kind.** Import `TrendingDown` (line 3) and make the header + body kind-aware. Replace the copy paragraph (lines 67-70):

```jsx
          <p className="text-sm text-navy">
            A new {session.kind === 'sell' ? 'sell' : 'voting'} session on{' '}
            <strong>{session.ticker}</strong> was started by{' '}
            <strong>{session.creator?.name}</strong>.{' '}
            {session.kind === 'sell'
              ? 'Cast your Sell or Hold rating before the deadline.'
              : 'Cast your Buy, Hold, or Sell vote before the deadline.'}
          </p>
```

And swap the header icon (line 47) to `{session.kind === 'sell' ? <TrendingDown className="h-8 w-8" /> : <TrendingUp className="h-8 w-8" />}`. Leave the gradient as-is (kept simple).

- [ ] **Step 2: Build + commit.** Run: `cd client && npm run build`

```bash
git add client/src/components/VoteNotification.jsx
git commit -m "feat: kind-aware vote-now popup copy for sell votes"
```

---

## Task 8: TradeRequests.jsx — passed-sell-votes picker

**Files:**
- Modify: `client/src/pages/TradeRequests.jsx` (Composer, lines 287-531+)

- [ ] **Step 1: Load eligible sell votes.** In `Composer`, add state next to `eligible` (line 288) and selection state next to `selectedIds` (line 289):

```js
  const [eligibleSells, setEligibleSells] = useState([]);
  const [selectedSellIds, setSelectedSellIds] = useState(new Set());
```

In the `open` effect (lines 310-327), reset `setSelectedSellIds(new Set())` and fetch both lists:

```js
    setSelectedSellIds(new Set());
    api
      .get('/trade-requests/eligible-sells')
      .then((res) => setEligibleSells(res.data))
      .catch(() => setEligibleSells([]));
```

- [ ] **Step 2: Quote the selected sell-vote tickers.** In the quote effect (lines 330-358), also add the selected sell-vote tickers to the `tickers` set:

```js
    for (const id of selectedSellIds) {
      const s = eligibleSells.find((e) => e.id === id);
      if (s) tickers.add(String(s.ticker).toUpperCase());
    }
```

Add `selectedSellIds, eligibleSells` to that effect's dependency array (line 358).

- [ ] **Step 3: Add vote-driven sell lines to the preview.** In the `lines` memo (lines 393-465), after building `sellLine`, build the vote-driven sell lines (sized to the held position) and return them:

```js
    const voteSells = [];
    for (const id of selectedSellIds) {
      const s = eligibleSells.find((e) => e.id === id);
      if (!s) continue;
      const t = String(s.ticker).toUpperCase();
      const quote = quotes[t];
      const shares = s.heldShares != null ? Math.round(s.heldShares) : null;
      voteSells.push({
        kind: 'Sell',
        votingSessionId: s.id,
        ticker: t,
        quote,
        shares,
        heldShares: s.heldShares ?? null,
        totalCost: quote?.status === 'ok' && shares ? shares * quote.price : null,
      });
    }

    return { buys, sellLine, voteSells };
```

Add `selectedSellIds, eligibleSells` to the memo's dependency array (lines 455-465).

- [ ] **Step 4: Include vote sells in totals + readiness.** Update `sellTotal` (line 468) and `allLinesReady` (lines 485-490):

```js
  const voteSellTotal = lines.voteSells.reduce((s, v) => s + (v.totalCost || 0), 0);
  const sellTotal = (lines.sellLine?.totalCost || 0) + voteSellTotal;
```

In `allLinesReady`, require every vote sell to be priced and to have a non-null `heldShares` (can't sell a position the sheet says we don't hold):

```js
  const voteSellsReady = lines.voteSells.every(
    (v) => v.shares != null && v.shares > 0 && v.totalCost != null
  );
```

Add `&& voteSellsReady` to `allLinesReady`, and require at least one line overall — change the `lines.buys.length > 0` gate to `(lines.buys.length > 0 || lines.voteSells.length > 0 || sellEnabled)`.

- [ ] **Step 5: Post vote-driven sell items.** In `handleSubmit` (lines 501-526), after pushing buys and before/after the manual sell line, push the vote sells:

```js
      for (const v of lines.voteSells) {
        items.push({ kind: 'Sell', votingSessionId: v.votingSessionId });
      }
```

- [ ] **Step 6: Render the picker.** Add a "Passed sell votes" section in the composer body — mirror the eligible-buys list. Place it just before the Sell-to-cover block. Minimal list with a checkbox per session:

```jsx
              {eligibleSells.length > 0 && (
                <div className="mt-6">
                  <div className="text-xs font-semibold uppercase tracking-wider text-navy-400">
                    Passed sell votes
                  </div>
                  <div className="mt-2 space-y-2">
                    {eligibleSells.map((s) => {
                      const checked = selectedSellIds.has(s.id);
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                            checked ? 'border-red-300 bg-red-50/50' : 'border-navy-100 bg-white'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedSellIds((prev) => {
                                  const next = new Set(prev);
                                  next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                                  return next;
                                })
                              }
                            />
                            <TrendingDown className="h-4 w-4 text-red-700" />
                            <span className="font-bold text-navy">{s.ticker}</span>
                            <span className="text-xs text-navy-400">
                              {s.heldShares != null ? `sell all ${s.heldShares} sh` : 'no position on sheet'}
                            </span>
                          </span>
                          {s.heldShares == null && (
                            <span className="text-[10px] font-semibold text-red-700">unavailable</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
```

- [ ] **Step 7: Build.** Run: `cd client && npm run build`
Expected: build succeeds. Manually confirm: with a passed sell vote present, it lists; selecting it adds a Sell line to the preview totals.

- [ ] **Step 8: Commit.**

```bash
git add client/src/pages/TradeRequests.jsx
git commit -m "feat: bundle passed sell votes into trade-approval envelopes"
```

---

## Task 9: Full verification

- [ ] **Step 1: Server tests.** Run: `cd server && npm test`
Expected: all suites pass, including `votes.kind.test.js` and `tradeRequests.sells.test.js`.

- [ ] **Step 2: Server syntax sweep.** Run: `cd server && for f in src/routes/votes.js src/routes/tradeRequests.js src/routes/pitches.js src/routes/users.js src/services/articleSummarizer.js; do node --check $f && echo "ok $f"; done`

- [ ] **Step 3: Client build.** Run: `cd client && npm run build`
Expected: clean Vite build.

- [ ] **Step 4: Manual QA checklist** (note results; needs the dev server + a held position):
  - Start a Sell vote from a held position; only Sell/Hold appear, no allocation field.
  - Cast Sell and Hold from different members; weighting matches a buy vote.
  - Close; result shows SELL with an analyst recap; a buy pitch on the same ticker keeps its prior outcome.
  - In Trade Approvals, the passed sell vote lists, pre-sized to the whole position, and bundles into an envelope (DocuSign permitting).

- [ ] **Step 5: Final commit (if any QA fixups).**

---

## Self-review (completed by author)

- **Spec coverage:** schema kind (T1), kind-aware create/ballot + same weighting via unchanged `computeTally` (T2), analyst recap (T3), inference fix (T4), eligible-sells + Sell-line linking (T5), create toggle + position picker + sell ballot UI (T6), notification copy (T7), composer picker (T8), tests/build/QA (T9). All spec sections map to a task.
- **Placeholder scan:** none — every code step shows real code; commands have expected output.
- **Type consistency:** `kind` is a string `"buy"`/`"sell"` everywhere; helpers `resolveSessionKind`/`prepareBallot` (T2), `buildEligibleSells`/`resolveSellVoteLine` (T5) are referenced with matching signatures in their tests; the trade item shape `{ kind:'Sell', votingSessionId }` matches the server's `POST /` Sell branch (T5) and `eligible-sells` annotation field `heldShares` is consumed in T8.
