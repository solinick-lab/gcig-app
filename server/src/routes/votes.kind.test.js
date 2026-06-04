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

test('prepareBallot — fixed buy session is Buy/No (Hold) only, never an amount', () => {
  const session = { kind: 'buy', amountMode: 'fixed', fixedAmount: 5000 };
  // Buy ratifies the pinned figure; the per-voter amount is ignored.
  assert.deepEqual(prepareBallot(session, { action: 'Buy', investmentAmount: 9999 }), {
    action: 'Buy', investmentAmount: null,
  });
  // "No" arrives as Hold from the client.
  assert.deepEqual(prepareBallot(session, { action: 'Hold' }), {
    action: 'Hold', investmentAmount: null,
  });
  // Sell isn't an option in fixed mode.
  const sell = prepareBallot(session, { action: 'Sell' });
  assert.equal(sell.error !== undefined, true);
  assert.match(sell.error, /Buy or No/i);
});

test('computeTally — fixed session derives buyAmountStats from fixedAmount', () => {
  const users = [
    { id: 1, role: 'JuniorAnalyst' }, { id: 2, role: 'JuniorAnalyst' },
    { id: 3, role: 'JuniorAnalyst' }, { id: 9, role: 'President' },
  ];
  // Three Buy ratifications, one Hold. Buy ballots carry no amount.
  const ballots = [
    { userId: 1, action: 'Buy', investmentAmount: null },
    { userId: 2, action: 'Buy', investmentAmount: null },
    { userId: 3, action: 'Hold', investmentAmount: null },
    { userId: 9, action: 'Buy', investmentAmount: null },
  ];
  const t = computeTally(ballots, users, { amountMode: 'fixed', fixedAmount: 5000 });
  assert.equal(t.finalDecision, 'Buy');
  assert.deepEqual(t.buyAmountStats, {
    count: 3, avg: 5000, min: 5000, max: 5000, fixed: true,
  });
});

test('computeTally — fixed session with no Buy ratifications has null stats', () => {
  const users = [{ id: 1, role: 'JuniorAnalyst' }];
  const ballots = [{ userId: 1, action: 'Hold', investmentAmount: null }];
  const t = computeTally(ballots, users, { amountMode: 'fixed', fixedAmount: 5000 });
  assert.equal(t.buyAmountStats, null);
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
