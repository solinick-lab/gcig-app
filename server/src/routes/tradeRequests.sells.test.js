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
