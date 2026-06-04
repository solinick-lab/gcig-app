import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireExecutive } from '../middleware/auth.js';
import { summarizeVoteSession } from '../services/articleSummarizer.js';

const router = Router();
router.use(verifyJwt);

// ── Tally computation ──────────────────────────────────────────────

// Weighting rules:
//   General body's majority choice = 3 weighted votes
//   Each Leadership member (President or CIO) = 1 weighted vote
// Leadership ballots contribute individually; general body contributes as a
// single bloc whose direction is its majority (tied bloc = 0 contribution).
const GENERAL_BODY_WEIGHT = 3;
const LEADERSHIP_ROLES = new Set(['President', 'CIO']);

export function computeTally(ballots, allUsers, session = {}) {
  const userMap = new Map(allUsers.map((u) => [u.id, u]));

  const leadershipBallots = ballots.filter((b) =>
    LEADERSHIP_ROLES.has(userMap.get(b.userId)?.role)
  );
  const memberBallots = ballots.filter(
    (b) => !LEADERSHIP_ROLES.has(userMap.get(b.userId)?.role)
  );

  // Max possible weighted votes = general-body bloc + # of leadership seats
  // currently held. Used by the client to draw progress bars and "X of Y"
  // counters without guessing the ceiling.
  const leadershipEligible = allUsers.filter((u) => LEADERSHIP_ROLES.has(u.role)).length;
  const maxWeightedVotes = GENERAL_BODY_WEIGHT + leadershipEligible;

  // General body counts
  const memberCounts = { Buy: 0, Hold: 0, Sell: 0 };
  for (const b of memberBallots) memberCounts[b.action]++;

  const maxMemberVotes = Math.max(memberCounts.Buy, memberCounts.Hold, memberCounts.Sell);
  const memberWinners = Object.keys(memberCounts).filter(
    (k) => memberCounts[k] === maxMemberVotes && memberCounts[k] > 0
  );
  // Tie in general body → 0 contribution; leadership decides alone.
  const generalBodyDecision = memberWinners.length === 1 ? memberWinners[0] : null;

  // Final weighted tally
  const weights = { Buy: 0, Hold: 0, Sell: 0 };
  for (const b of leadershipBallots) weights[b.action]++;
  if (generalBodyDecision) weights[generalBodyDecision] += GENERAL_BODY_WEIGHT;

  const maxWeight = Math.max(weights.Buy, weights.Hold, weights.Sell);
  const finalWinners = Object.keys(weights).filter(
    (k) => weights[k] === maxWeight && weights[k] > 0
  );
  // Tie in final → default to Hold (conservative).
  const finalDecision = finalWinners.length === 1 ? finalWinners[0] : 'Hold';

  // Aggregate what the voters want to allocate. Only Buy ballots carry an
  // amount; we surface the average + min + max so leadership can see at a
  // glance how much the club thinks to commit.
  const buyAmounts = ballots
    .filter((b) => b.action === 'Buy' && typeof b.investmentAmount === 'number')
    .map((b) => b.investmentAmount);
  let buyAmountStats =
    buyAmounts.length > 0
      ? {
          count: buyAmounts.length,
          avg: buyAmounts.reduce((s, n) => s + n, 0) / buyAmounts.length,
          min: Math.min(...buyAmounts),
          max: Math.max(...buyAmounts),
        }
      : null;

  // Fixed-amount session: the allocation isn't an aggregate of ballots,
  // it's the number the creator pinned. Ballots carry no amount (a Buy is
  // just an "I support it" ratification), so we synthesize the stats from
  // fixedAmount with the Buy headcount. Same shape as the average case so
  // every downstream consumer — the DocuSign share math, the Trade
  // Requests sizing, the client card — reads it without special-casing.
  // The `fixed` flag lets the UI relabel "average across N" as "fixed".
  if (session.amountMode === 'fixed' && typeof session.fixedAmount === 'number') {
    const buyCount = ballots.filter((b) => b.action === 'Buy').length;
    buyAmountStats =
      buyCount > 0
        ? {
            count: buyCount,
            avg: session.fixedAmount,
            min: session.fixedAmount,
            max: session.fixedAmount,
            fixed: true,
          }
        : null;
  }

  return {
    memberCounts,
    memberTotal: memberBallots.length,
    generalBodyDecision,
    generalBodyWeight: generalBodyDecision ? GENERAL_BODY_WEIGHT : 0,
    generalBodyBlocWeight: GENERAL_BODY_WEIGHT,
    leadershipVotes: leadershipBallots.map((b) => ({
      userId: b.userId,
      name: userMap.get(b.userId)?.name || 'Unknown',
      role: userMap.get(b.userId)?.role || null,
      action: b.action,
      note: b.note,
      investmentAmount: b.investmentAmount ?? null,
    })),
    buyAmountStats,
    leadershipCount: leadershipBallots.length,
    leadershipEligible,
    maxWeightedVotes,
    weights,
    totalWeightedVotes:
      (generalBodyDecision ? GENERAL_BODY_WEIGHT : 0) + leadershipBallots.length,
    finalDecision,
    isTied: finalWinners.length > 1,
  };
}

// ── Auto-close expired sessions (lazy evaluation) ──────────────────

async function closeExpiredSessions() {
  await prisma.votingSession.updateMany({
    where: { status: 'open', deadline: { lte: new Date() } },
    data: { status: 'closed', closedAt: new Date() },
  });
}

// ── Routes ──────────────────────────────────────────────────────────

// List all sessions (with ballot counts + status).
router.get('/', async (_req, res) => {
  await closeExpiredSessions();
  const sessions = await prisma.votingSession.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      creator: { select: { id: true, name: true, role: true } },
      pitch: { select: { id: true, ticker: true, pitcherName: true, slideshowUrl: true } },
      _count: { select: { ballots: true } },
    },
  });
  res.json(sessions);
});

// Most recent OPEN session the current user hasn't voted in (for popup).
router.get('/pending', async (req, res) => {
  await closeExpiredSessions();
  const session = await prisma.votingSession.findFirst({
    where: {
      status: 'open',
      ballots: { none: { userId: req.user.id } },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      creator: { select: { id: true, name: true, role: true } },
      pitch: { select: { id: true, ticker: true, pitcherName: true } },
    },
  });
  res.json(session || null);
});

// Session detail — includes all ballots + live tally.
router.get('/:id', async (req, res) => {
  await closeExpiredSessions();
  const id = Number(req.params.id);
  const session = await prisma.votingSession.findUnique({
    where: { id },
    include: {
      creator: { select: { id: true, name: true, role: true } },
      pitch: { select: { id: true, ticker: true, pitcherName: true, slideshowUrl: true, date: true } },
      ballots: {
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { castAt: 'asc' },
      },
    },
  });
  if (!session) return res.status(404).json({ error: 'Not found' });

  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, role: true },
  });

  const tally = computeTally(session.ballots, allUsers, session);
  const myBallot = session.ballots.find((b) => b.userId === req.user.id) || null;

  // Lazily generate the closed-session recap the first time anyone views a
  // session after it closes. Saved on the row so future views just return
  // the cached text. Fire-and-forget for the write so the response isn't
  // held up by the LLM call on a cold model.
  let synthesis = session.synthesis;
  if (!synthesis && session.status !== 'open' && process.env.LOCAL_LLM_URL) {
    synthesis = await summarizeVoteSession({ ...session, tally });
    if (synthesis) {
      prisma.votingSession
        .update({ where: { id }, data: { synthesis } })
        .catch((err) =>
          console.warn('vote synthesis save failed:', err.message)
        );
    }
  }

  res.json({ ...session, tally, myBallot, synthesis });
});

// Create a new voting session (President only).
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

  // Buy sessions choose how the trade is sized. "fixed" pins a dollar
  // figure the creator names (members only ratify it); anything else is
  // the default "average" of the Buy ballots. Sell sessions never carry
  // an amount, so the mode is forced to average and the figure dropped.
  let amountMode = 'average';
  let fixedAmount = null;
  if (kind === 'buy' && String(req.body?.amountMode).toLowerCase() === 'fixed') {
    const n = Number(req.body?.fixedAmount);
    if (!Number.isFinite(n) || n < BUY_MIN || n > BUY_MAX) {
      return res
        .status(400)
        .json({ error: `Fixed amount must be between $${BUY_MIN} and $${BUY_MAX}` });
    }
    amountMode = 'fixed';
    fixedAmount = Math.round(n);
  }

  const session = await prisma.votingSession.create({
    data: {
      ticker: ticker.toUpperCase(),
      title: title || null,
      // A sell vote is about a holding, not a pitch — never attach one.
      pitchId: kind === 'buy' && pitchId ? Number(pitchId) : null,
      kind,
      amountMode,
      fixedAmount,
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

// Dollar bounds for a Buy ballot. Mirrored in the client inputs.
const BUY_MIN = 1500;
const BUY_MAX = 10000;

// Resolve the requested session kind. Defaults to "buy"; anything that
// isn't a known kind returns null so the route can 400.
export function resolveSessionKind(raw) {
  const k = String(raw ?? 'buy').toLowerCase();
  return k === 'buy' || k === 'sell' ? k : null;
}

// Validate + normalize a ballot for a session. Accepts the session (or a
// bare kind string, for the unit tests). Returns { action,
// investmentAmount } on success or { error } on rejection.
//   Buy / average : Buy/Hold/Sell, Buy carries a $1,500–$10,000 amount.
//   Buy / fixed   : Buy or No only — the dollar figure is pinned on the
//                   session, so a ballot never carries one. "No" maps to
//                   Hold so the shared tally machinery is untouched.
//   Sell          : Sell or Hold only, never an amount (we exit the whole
//                   position; leadership sizes the order downstream).
export function prepareBallot(session, { action, investmentAmount } = {}) {
  const kind = typeof session === 'string' ? session : session?.kind ?? 'buy';
  const amountMode = typeof session === 'object' ? session?.amountMode : 'average';

  if (kind === 'sell') {
    if (action !== 'Sell' && action !== 'Hold') {
      return { error: 'action must be Sell or Hold' };
    }
    return { action, investmentAmount: null };
  }

  // Fixed-amount buy: a yes/no ratification of the pinned figure. The
  // client surfaces "No" but persists it as Hold so weighting is shared.
  if (amountMode === 'fixed') {
    if (action !== 'Buy' && action !== 'Hold') {
      return { error: 'action must be Buy or No' };
    }
    return { action, investmentAmount: null };
  }

  if (!['Buy', 'Hold', 'Sell'].includes(action)) {
    return { error: 'action must be Buy, Hold, or Sell' };
  }
  if (action === 'Buy') {
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

// Cast or update your ballot on an open session.
router.post('/:id/ballot', async (req, res) => {
  const sessionId = Number(req.params.id);
  const session = await prisma.votingSession.findUnique({ where: { id: sessionId } });
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'open' || new Date() > session.deadline) {
    return res.status(400).json({ error: 'Voting is closed for this session' });
  }

  // The allowed actions depend on the session kind: a sell vote is Sell or
  // Hold and never carries a dollar amount; a buy vote keeps Buy/Hold/Sell
  // with the proposed-allocation band on Buy.
  const prepared = prepareBallot(session, req.body || {});
  if (prepared.error) return res.status(400).json({ error: prepared.error });
  const { action, investmentAmount: amount } = prepared;
  const note = req.body?.note;

  const ballot = await prisma.ballot.upsert({
    where: { sessionId_userId: { sessionId, userId: req.user.id } },
    update: {
      action,
      note: note || null,
      investmentAmount: amount,
      castAt: new Date(),
    },
    create: {
      sessionId,
      userId: req.user.id,
      action,
      note: note || null,
      investmentAmount: amount,
    },
    include: { user: { select: { id: true, name: true, role: true } } },
  });
  res.json(ballot);
});

// Close a session early (President only).
router.post('/:id/close', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const session = await prisma.votingSession.update({
    where: { id },
    data: { status: 'closed', closedAt: new Date() },
  });
  res.json(session);
});

// Delete a session (President only).
router.delete('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  await prisma.votingSession.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
