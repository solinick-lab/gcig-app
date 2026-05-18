import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import prisma from '../db.js';
import {
  verifyJwt,
  requirePresidentOrSuperAdmin,
  requireExecutive,
  requireSuperAdmin,
  requireRole,
  ROLE_RANK,
} from '../middleware/auth.js';
import { sendInviteEmail, primaryClientOrigin } from '../services/email.js';
import { auditReq } from '../services/audit.js';
import { nameProfile } from '../services/nameGender.js';
import { computeParticipation } from '../services/participation.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

const router = Router();

const ROLES = [
  'President',
  'CIO',
  'ChiefOfCommunication',
  'SeniorPortfolioManager',
  'PortfolioManager',
  'SeniorAnalyst',
  'Analyst',
  'JuniorAnalyst',
  'AdvisoryBoardMember',
  'FacultyAdvisory',
  // Honorific badge only — valid in extraRoles, never as a primary role.
  'FormerPresident',
];

// Roles that may be set as a member's *primary* role. FormerPresident is
// excluded: it is granted exclusively as an extraRoles badge by the
// step-down action, never picked from a role list. This is the
// server-side guarantee that "Former President" can only ever be a badge.
const ASSIGNABLE_ROLES = ROLES.filter((r) => r !== 'FormerPresident');

function generateTempPassword() {
  return crypto.randomBytes(6).toString('base64url') + '!A1';
}

// Public lunch availability for leadership. Has to be declared before
// the router-wide verifyJwt below: the Calendar page mounts and fires
// this in parallel with /auth/me, and on a freshly-logged-in render
// the JWT-bearing axios instance can race the auth bootstrap and send
// a request before the token is wired up. The data is non-sensitive
// (names + roles + lunch periods of leaders only — Request-a-Pitch
// needs it before the requester is even a member), so gating it just
// to satisfy a global middleware was a mistake.
router.get('/lunch/leaders', async (_req, res) => {
  const leaders = await prisma.user.findMany({
    where: {
      OR: [
        { role: 'President' },
        { role: 'PortfolioManager' },
        { role: 'SeniorPortfolioManager' },
        { ledIndustries: { some: {} } },
      ],
    },
    select: {
      id: true,
      name: true,
      role: true,
      lunchSchedule: true,
      ledIndustries: { select: { id: true, name: true } },
    },
    orderBy: { name: 'asc' },
  });
  res.json(
    leaders.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      lunchSchedule: u.lunchSchedule || null,
      industries: u.ledIndustries,
    }))
  );
});

router.use(verifyJwt);

// Portfolio Manager and above: participation ranking. Aggregates
// attendance, pitches, and role rank into a single 0-100 score with a
// per-component breakdown, so PMs (and execs) can see exactly why each
// member ranks where they do when planning meeting groups or promotions.
router.get('/participation', requireRole('PortfolioManager'), async (_req, res) => {
  try {
    const data = await computeParticipation(prisma);
    res.json(data);
  } catch (err) {
    console.error('participation aggregation failed:', err.message);
    res.status(500).json({ error: 'Failed to compute participation ranking' });
  }
});

// ── Lunch schedule ────────────────────────────────────────────────────
// Stored on User.lunchSchedule as JSON: { mon, tue, wed, thu, fri } where
// each value is 'First' | 'Second' | 'Both' | null. Used by the
// Request-a-Pitch flow so requesters can pick a lunch period the
// President / their PM is actually free.
const LUNCH_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const LUNCH_VALUES = new Set(['First', 'Second', 'Both', null]);

function sanitizeLunchSchedule(input) {
  if (input == null) return null;
  if (typeof input !== 'object') {
    const err = new Error('lunchSchedule must be an object');
    err.status = 400;
    throw err;
  }
  const out = {};
  for (const day of LUNCH_DAYS) {
    const v = input[day] ?? null;
    if (!LUNCH_VALUES.has(v)) {
      const err = new Error(`Invalid lunch value for ${day}`);
      err.status = 400;
      throw err;
    }
    out[day] = v;
  }
  return out;
}

router.get('/me/lunch', async (req, res) => {
  const u = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { lunchSchedule: true },
  });
  res.json({ lunchSchedule: u?.lunchSchedule || null });
});

router.put('/me/lunch', async (req, res) => {
  let lunchSchedule;
  try {
    lunchSchedule = sanitizeLunchSchedule(req.body?.lunchSchedule);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  await prisma.user.update({
    where: { id: req.user.id },
    data: { lunchSchedule },
  });
  res.json({ lunchSchedule });
});

// All authed users can list members (shown on attendance sheet)
router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      extraRoles: true,
      twoFactorEnabled: true,
      createdAt: true,
      industries: {
        include: { industry: { select: { id: true, name: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });
  // Flatten industries for easier client use.
  const shaped = users.map((u) => ({
    ...u,
    industries: u.industries.map((ui) => ui.industry),
  }));
  res.json(shaped);
});

// Super-admin-only: name-gender inference readout for every member.
// Exposes what the app THINKS each person's first name implies
// (honorific, pronouns, gender, confidence) so the owner can spot
// wrong guesses — e.g. a unisex name that flipped the wrong way. Not
// visible to regular members; treat as internal-only telemetry.
router.get('/name-inference', requireSuperAdmin, async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  });
  const rows = users.map((u) => {
    const p = nameProfile(u.name || '');
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      firstName: p.firstName,
      lastName: p.lastName,
      gender: p.gender, // 'M' | 'F' | 'U'
      confidence: p.confidence,
      honorific: p.honorific,
      honorificName: p.honorificName,
      pronouns: p.pronouns,
    };
  });
  res.json(rows);
});

// Full per-member profile. Any authed user can view any profile —
// this is the same tier of info already visible on the Members page,
// just organized per-person. Returns the member's roster data plus
// every pitch they've given, their attendance record, and a sample
// of recent votes. Advisory-tier + Chief-of-Comms members are
// flagged as attendance-exempt so the UI can hide the attendance tile.
const ATTENDANCE_EXEMPT_ROLES = new Set([
  'AdvisoryBoardMember',
  'FacultyAdvisory',
  'ChiefOfCommunication',
]);

router.get('/:id/profile', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad id' });
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      role: true,
      extraRoles: true,
      createdAt: true,
      industries: {
        include: { industry: { select: { id: true, name: true } } },
      },
    },
  });
  if (!user) return res.status(404).json({ error: 'Member not found' });

  // Pitches — union of structured PitchPresenter rows (new style) and
  // legacy pitcherName matches, dedup by pitch id, ordered newest first.
  // Research Reports are authored by name (similar legacy match) and
  // count as contributions alongside pitches — members think of a
  // written report on MLAB the same way they think of presenting it.
  const [presenterRows, nameRows, reportRows] = await Promise.all([
    prisma.pitchPresenter.findMany({
      where: { userId: id },
      include: {
        pitch: {
          select: {
            id: true,
            ticker: true,
            date: true,
            votedOutcome: true,
            pitcherName: true,
            industry: { select: { name: true } },
          },
        },
      },
    }),
    prisma.pitch.findMany({
      where: { pitcherName: user.name },
      select: {
        id: true,
        ticker: true,
        date: true,
        votedOutcome: true,
        pitcherName: true,
        industry: { select: { name: true } },
      },
    }),
    prisma.report.findMany({
      where: { author: user.name },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        title: true,
        ticker: true,
        date: true,
        description: true,
        fileUrl: true,
      },
    }),
  ]);
  const pitchMap = new Map();
  for (const p of nameRows) pitchMap.set(p.id, p);
  for (const r of presenterRows) pitchMap.set(r.pitch.id, r.pitch);
  const rawPitches = [...pitchMap.values()].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  // Infer an effective outcome so the UI isn't misleading. Three
  // signals, in priority order:
  //   1. Pitch.votedOutcome — explicit override, always wins.
  //   2. Closed VotingSession on the ticker — counts Buy ballots vs
  //      Hold/Sell. Majority Buy → 'Approved' (vote passed, may not
  //      yet be executed). Majority not-Buy → 'NoBuy'.
  //   3. Currently held in portfolio — pitch obviously got bought
  //      even if both above are missing → 'Buy'.
  //   4. Future-dated pitch with no signal → 'Scheduled'.
  //   5. Otherwise → 'Pending'.
  //
  // The 'Approved' state distinguishes "club voted yes, traders haven't
  // executed yet" from "in the book and earning a return". Both are
  // fine outcomes; just different stages.
  let heldTickers = new Set();
  try {
    const sheet = await getSheetPortfolio();
    heldTickers = new Set(
      sheet.holdings
        .filter((h) => !h.isCash && h.ticker)
        .map((h) => h.ticker.toUpperCase())
    );
  } catch {
    /* sheet unreachable — fall back to raw votedOutcome only. */
  }

  // Most-recent closed VotingSession per ticker, with the Buy/NoBuy
  // call computed from the ballots. Keys are upper-case tickers.
  const voteOutcomeByTicker = new Map();
  const pitchTickers = Array.from(
    new Set(
      rawPitches
        .map((p) => String(p.ticker || '').toUpperCase())
        .filter(Boolean)
    )
  );
  if (pitchTickers.length > 0) {
    const sessions = await prisma.votingSession.findMany({
      where: { ticker: { in: pitchTickers }, status: 'closed' },
      orderBy: { closedAt: 'desc' },
      select: {
        ticker: true,
        closedAt: true,
        ballots: { select: { action: true } },
      },
    });
    for (const s of sessions) {
      const key = s.ticker.toUpperCase();
      if (voteOutcomeByTicker.has(key)) continue; // first iter is most recent
      let buys = 0;
      let nonBuys = 0;
      for (const b of s.ballots) {
        if (b.action === 'Buy') buys++;
        else nonBuys++;
      }
      if (buys === 0 && nonBuys === 0) continue; // empty session, ignore
      voteOutcomeByTicker.set(key, buys > nonBuys ? 'Buy' : 'NoBuy');
    }
  }

  const now = new Date();
  const pitches = rawPitches.map((p) => {
    const ticker = String(p.ticker || '').toUpperCase();
    const pitchDate = new Date(p.date);
    let effectiveOutcome = p.votedOutcome || null;
    let outcomeInferred = false;
    if (!effectiveOutcome) {
      const voteCall = voteOutcomeByTicker.get(ticker);
      if (voteCall === 'Buy') {
        // Vote passed. If the holding's already in the portfolio,
        // it's a real Buy; otherwise it's an Approved (awaiting trade).
        if (heldTickers.has(ticker)) {
          effectiveOutcome = 'Buy';
          outcomeInferred = true;
        } else {
          effectiveOutcome = 'Approved';
          outcomeInferred = true;
        }
      } else if (voteCall === 'NoBuy') {
        effectiveOutcome = 'NoBuy';
        outcomeInferred = true;
      } else if (pitchDate > now) {
        effectiveOutcome = 'Scheduled';
      } else if (heldTickers.has(ticker)) {
        // No closed vote, no explicit outcome, but it's in the book —
        // legacy inference for older pitches predating voting sessions.
        effectiveOutcome = 'Buy';
        outcomeInferred = true;
      }
    }
    return { ...p, effectiveOutcome, outcomeInferred };
  });

  // Merged contributions feed: pitches + reports, sorted newest first.
  // Each entry has a `kind` so the client can render the right pill
  // and fields. Reports carry a fileUrl for download.
  const contributions = [
    ...pitches.map((p) => ({
      kind: 'pitch',
      id: `pitch-${p.id}`,
      ticker: p.ticker,
      date: p.date,
      industry: p.industry?.name || null,
      effectiveOutcome: p.effectiveOutcome,
      outcomeInferred: p.outcomeInferred,
    })),
    ...reportRows.map((r) => ({
      kind: 'report',
      id: `report-${r.id}`,
      ticker: r.ticker || null,
      date: r.date,
      title: r.title,
      description: r.description || null,
      fileUrl: r.fileUrl || null,
    })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  // Attendance summary. Exempt roles skip the whole block.
  const isExempt = ATTENDANCE_EXEMPT_ROLES.has(user.role);
  let attendance = null;
  if (!isExempt) {
    const records = await prisma.attendance.findMany({
      where: { userId: id },
      select: { status: true },
    });
    const present = records.filter((r) => r.status === 'Present').length;
    const absent = records.filter((r) => r.status === 'Absent').length;
    const excused = records.filter((r) => r.status === 'Excused').length;
    const total = records.length;
    attendance = {
      total,
      present,
      absent,
      excused,
      // "Rate" here matches /attendance/mine: present + excused counts
      // as credit so a legit absence isn't held against a member.
      rate:
        total > 0 ? Math.round(((present + excused) / total) * 100) : null,
    };
  }

  // Votes — latest 10 + total count. Gives the UI a feed for the
  // profile without dumping every ballot the member has ever cast.
  const [ballots, totalVotes] = await Promise.all([
    prisma.ballot.findMany({
      where: { userId: id },
      orderBy: { castAt: 'desc' },
      take: 10,
      include: {
        session: { select: { ticker: true, closedAt: true, status: true } },
      },
    }),
    prisma.ballot.count({ where: { userId: id } }),
  ]);

  const profile = nameProfile(user.name || '');

  res.json({
    id: user.id,
    name: user.name,
    role: user.role,
    extraRoles: user.extraRoles,
    createdAt: user.createdAt,
    firstName: profile.firstName,
    honorificName: profile.honorificName,
    industries: user.industries.map((ui) => ui.industry),
    pitches,
    reports: reportRows,
    // Unified pitches + reports feed — clients should prefer this over
    // reading `pitches` + `reports` separately.
    contributions,
    attendance,
    attendanceExempt: isExempt,
    votes: {
      total: totalVotes,
      recent: ballots.map((b) => ({
        sessionId: b.sessionId,
        ticker: b.session?.ticker || null,
        action: b.action,
        investmentAmount: b.investmentAmount,
        castAt: b.castAt,
        status: b.session?.status || null,
      })),
    },
  });
});

// Invite a new member. No account is created yet — just a PendingInvite record
// and an email with a one-time link where they set their own password.
router.post('/', requireExecutive, async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, role required' });
  }
  if (!ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const normalized = String(email).trim().toLowerCase();

  // Reject if a real account already exists for this email.
  const existingUser = await prisma.user.findUnique({ where: { email: normalized } });
  if (existingUser) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  // Upsert so re-inviting the same email just generates a fresh token.
  await prisma.pendingInvite.upsert({
    where: { email: normalized },
    update: { name: String(name).trim(), role, token, expiresAt },
    create: {
      email: normalized,
      name: String(name).trim(),
      role,
      token,
      expiresAt,
    },
  });

  const inviteUrl = `${primaryClientOrigin()}/accept-invite?token=${token}`;

  const ROLE_LABELS = {
    President: 'President',
    CIO: 'CIO',
    ChiefOfCommunication: 'Chief of Communication',
    SeniorPortfolioManager: 'Senior Portfolio Manager',
    PortfolioManager: 'Portfolio Manager',
    SeniorAnalyst: 'Senior Analyst',
    Analyst: 'Analyst',
    JuniorAnalyst: 'Junior Analyst',
    AdvisoryBoardMember: 'Advisory Board Member',
    FacultyAdvisory: 'Faculty Advisor',
    FormerPresident: 'Former President',
  };

  let emailSent = false;
  try {
    await sendInviteEmail(normalized, {
      name: String(name).trim(),
      role: ROLE_LABELS[role] || role,
      inviteUrl,
    });
    emailSent = true;
  } catch (emailErr) {
    console.error('Invite email failed:', emailErr.message);
  }

  await auditReq(req, 'user.invited', 'user', null, {
    email: normalized,
    role,
    emailSent,
  });
  res.status(201).json({
    email: normalized,
    name: String(name).trim(),
    role,
    inviteUrl,
    emailSent,
  });
});

router.put('/:id', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const { name, email, role } = req.body || {};
  if (role && !ASSIGNABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email: email.toLowerCase() } : {}),
      ...(role !== undefined ? { role } : {}),
    },
    select: { id: true, name: true, email: true, role: true, createdAt: true },
  });
  await auditReq(req, 'user.updated', 'user', user.id, { name, email, role });
  res.json(user);
});

// Roles only the President can assign. They sit outside the operational
// hierarchy and must never be handed out by an industry leader.
const PRESIDENT_ONLY_ROLES = new Set(['AdvisoryBoardMember', 'FacultyAdvisory']);

// Change a user's primary role.
//   - President: can change anyone's role to anything.
//   - Industry leader: can change roles of members in industries they lead,
//     but only if target's current rank AND new rank are both strictly below
//     the leader's own rank. Cannot touch AB/Faculty (either to assign or to
//     modify someone already in those roles).
//   - Everyone else: forbidden.
router.put('/:id/role', async (req, res) => {
  const targetId = Number(req.params.id);
  const { role: newRole } = req.body || {};
  if (!newRole || !ASSIGNABLE_ROLES.includes(newRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) return res.status(404).json({ error: 'User not found' });

  // President: no restrictions at all.
  if (req.user.role === 'President') {
    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { role: newRole },
      select: { id: true, name: true, email: true, role: true, extraRoles: true },
    });
    await auditReq(req, 'user.role_changed', 'user', targetId, {
      from: target.role,
      to: newRole,
      by: 'president',
    });
    return res.json(updated);
  }

  // Non-Presidents cannot assign or remove Advisory Board / Faculty roles.
  if (PRESIDENT_ONLY_ROLES.has(newRole)) {
    return res.status(403).json({
      error: 'Only the President can assign Advisory Board or Faculty Advisor roles',
    });
  }
  if (PRESIDENT_ONLY_ROLES.has(target.role)) {
    return res.status(403).json({
      error: 'Only the President can modify Advisory Board or Faculty Advisor members',
    });
  }

  const callerRank = ROLE_RANK[req.user.role] ?? 0;
  const currentRank = ROLE_RANK[target.role] ?? 0;
  const newRank = ROLE_RANK[newRole] ?? 0;

  // CIO can manage any user ranked below them — no industry scoping.
  if (req.user.role === 'CIO') {
    if (currentRank >= callerRank) {
      return res.status(403).json({ error: 'Target is at or above your rank' });
    }
    if (newRank >= callerRank) {
      return res.status(403).json({ error: "You can't assign a role at or above your own rank" });
    }
    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { role: newRole },
      select: { id: true, name: true, email: true, role: true, extraRoles: true },
    });
    return res.json(updated);
  }

  // Industry leaders: must lead an industry that contains the target.
  const sharedIndustry = await prisma.industry.findFirst({
    where: {
      leaderId: req.user.id,
      members: { some: { userId: targetId } },
    },
  });
  if (!sharedIndustry) {
    return res.status(403).json({
      error: "You can only change roles of members in industries you lead",
    });
  }

  if (currentRank >= callerRank) {
    return res.status(403).json({ error: 'Target is at or above your rank' });
  }
  if (newRank >= callerRank) {
    return res.status(403).json({ error: "You can't assign a role at or above your own rank" });
  }

  const updated = await prisma.user.update({
    where: { id: targetId },
    data: { role: newRole },
    select: { id: true, name: true, email: true, role: true, extraRoles: true },
  });
  res.json(updated);
});

// Set the entire extra roles array (replaces existing).
router.put('/:id/extra-roles', requireExecutive, async (req, res) => {
  const id = Number(req.params.id);
  const { extraRoles } = req.body || {};
  if (!Array.isArray(extraRoles)) {
    return res.status(400).json({ error: 'extraRoles must be an array' });
  }
  const invalid = extraRoles.find((r) => !ROLES.includes(r));
  if (invalid) return res.status(400).json({ error: `Invalid role: ${invalid}` });

  const user = await prisma.user.update({
    where: { id },
    data: { extraRoles },
    select: { id: true, name: true, email: true, role: true, extraRoles: true },
  });
  await auditReq(req, 'user.extra_roles_set', 'user', user.id, { extraRoles });
  res.json(user);
});

router.post('/:id/reset-password', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  // Rotate tokenVersion so the target's existing sessions die instantly.
  await prisma.user.update({
    where: { id },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });
  await auditReq(req, 'user.password_reset_by_admin', 'user', id);
  res.json({ tempPassword });
});

router.delete('/:id', requireSuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  await prisma.user.delete({ where: { id } });
  await auditReq(req, 'user.deleted', 'user', id);
  res.json({ ok: true });
});

// Step down a sitting President. Strips all power by setting the primary
// role to JuniorAnalyst, while preserving the title via a no-power
// "FormerPresident" badge in extraRoles (ROLE_RANK[FormerPresident] === 0;
// no permission gate reads extraRoles for rank). Atomic single update plus
// one audit entry. No tokenVersion rotation is needed: verifyJwt re-reads
// `role` from the DB on every request, so power is revoked on the target's
// very next request without forcing a re-login.
//
// Exported and dependency-injected (db, audit) so it can be unit-tested
// without a database, following the execBiosHandler precedent in
// routes/terminal.js.
export async function stepDownHandler(req, res, deps = {}) {
  const { db = prisma, audit = auditReq } = deps;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  const target = await db.user.findUnique({ where: { id } });
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'President') {
    return res
      .status(400)
      .json({ error: 'Only a sitting President can step down' });
  }

  const extraRoles = Array.from(
    new Set([...(target.extraRoles || []), 'FormerPresident'])
  );
  const updated = await db.user.update({
    where: { id },
    data: { role: 'JuniorAnalyst', extraRoles },
    select: { id: true, name: true, email: true, role: true, extraRoles: true },
  });

  await audit(req, 'user.stepped_down', 'user', id, {
    from: 'President',
    to: 'JuniorAnalyst',
    badge: 'FormerPresident',
  });
  res.json(updated);
}

// A sitting President OR the owner/super-admin. The owner must be able to
// perform a handover even without holding the President role themselves.
router.post('/:id/step-down', requirePresidentOrSuperAdmin, (req, res) =>
  stepDownHandler(req, res)
);

export default router;
