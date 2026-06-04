import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEligibleSells, resolveSellVoteLine, validateResolvedTrade } from './tradeRequests.js';

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

test('validateResolvedTrade rejects the same voting session claimed twice', () => {
  const resolved = [
    { kind: 'Sell', ticker: 'AAPL', shares: 60, votingSessionId: 10 },
    { kind: 'Sell', ticker: 'AAPL', shares: 60, votingSessionId: 10 },
  ];
  const out = validateResolvedTrade(resolved, new Map([['AAPL', 120]]));
  assert.match(out.error, /twice/i);
});

test('validateResolvedTrade rejects selling more of a ticker than we hold (cumulative)', () => {
  // Two different sell votes on AAPL, each sized to the whole 120-share position.
  const resolved = [
    { kind: 'Sell', ticker: 'AAPL', shares: 120, votingSessionId: 10 },
    { kind: 'Sell', ticker: 'AAPL', shares: 120, votingSessionId: 11 },
  ];
  const out = validateResolvedTrade(resolved, new Map([['AAPL', 120]]));
  assert.match(out.error, /only 120 .*held|240/i);
});

test('validateResolvedTrade allows sells within the held position', () => {
  const resolved = [
    { kind: 'Sell', ticker: 'AAPL', shares: 50, votingSessionId: 10 },
    { kind: 'Sell', ticker: 'AAPL', shares: 40, coverDefault: 0 }, // manual line, no session
    { kind: 'Buy', ticker: 'MSFT', shares: 10, votingSessionId: 20 },
  ];
  assert.equal(validateResolvedTrade(resolved, new Map([['AAPL', 120]])), null);
});

test('validateResolvedTrade skips the over-sell check when held shares are unknown', () => {
  const resolved = [{ kind: 'Sell', ticker: 'SPY', shares: 999 }];
  assert.equal(validateResolvedTrade(resolved, new Map()), null);
});
