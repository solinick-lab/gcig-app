import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, ROLE_RANK } from '../middleware/auth.js';
import { auditReq } from '../services/audit.js';
import {
  sendPitchRequestEmail,
  sendPitchRequestDecisionEmail,
  buildPitchMeetingIcs,
  primaryClientOrigin,
} from '../services/email.js';
import { downloadBuffer } from '../services/oneDriveStorage.js';
import { assertSafeHttpUrl } from '../services/validateUrl.js';
import {
  weekdayKeyFor,
  isValidSlot,
  isValidRoom,
  ROOM_LABELS,
} from '../lib/lunchSlots.js';

const router = Router();
router.use(verifyJwt);

// Anyone with a club role can request a pitch — gating on a minimum rank
// (Analyst+) keeps observers (Faculty Advisory, Advisory Board) out of the
// flow. Junior Analysts CAN request: the whole point is to give analysts at
// every level a path to the President.
const REQUESTER_MIN_RANK = ROLE_RANK.JuniorAnalyst;

function canRequest(req, res, next) {
  const rank = ROLE_RANK[req.user?.role] || 0;
  if (rank < REQUESTER_MIN_RANK) {
    return res.status(403).json({ error: 'Club member role required' });
  }
  next();
}

function pitchRequestInclude() {
  return {
    requester: { select: { id: true, name: true, email: true, role: true } },
    industry: { select: { id: true, name: true, leaderId: true } },
    pm: { select: { id: true, name: true, email: true, role: true } },
    president: { select: { id: true, name: true, email: true, role: true } },
  };
}

// Resolve the President of the club. We treat the role string as
// authoritative (single-president clubs); if multiple users hold the role,
// take the first (sorted by id for determinism). Returns null when no
// President exists yet — caller decides how to handle.
async function findPresident() {
  return prisma.user.findFirst({
    where: { role: 'President' },
    orderBy: { id: 'asc' },
    select: { id: true, name: true, email: true },
  });
}

// Best-effort attachment build for the deck. Returns null when:
//   - the deckRef is an external URL (Google Drive, etc.) — caller embeds
//     the link instead
//   - the OneDrive download fails for any reason (file removed, OneDrive
//     not connected). We don't want to fail the whole request flow just
//     because the attachment couldn't be fetched.
async function tryBuildAttachment(deckRef) {
  if (!deckRef) return null;
  if (!deckRef.startsWith('onedrive:')) return null;
  const itemId = deckRef.slice('onedrive:'.length);
  try {
    const { buffer, filename, contentType } = await downloadBuffer(itemId);
    return { filename, content: buffer, contentType };
  } catch (err) {
    console.warn(`pitch-request: attachment fetch failed for ${itemId}: ${err.message}`);
    return null;
  }
}

function deckLinkUrl(req, deckRef) {
  if (!deckRef) return null;
  if (deckRef.startsWith('onedrive:')) {
    // Authenticated download endpoint. Useful when attachment fetch fails
    // and as a fallback for the email body when sending succeeded.
    const origin = `${req.protocol}://${req.get('host')}`;
    return `${origin}/api/files/${encodeURIComponent(deckRef.slice('onedrive:'.length))}`;
  }
  return deckRef;
}

// ── Create ────────────────────────────────────────────────────────────

router.post('/', canRequest, async (req, res) => {
  const {
    ticker,
    companyName,
    thesis,
    industryId,
    proposedDate,
    proposedLunch,
    proposedStartTime,
    room,
    notes,
    deckRef,
  } = req.body || {};

  if (!ticker || !deckRef) {
    return res.status(400).json({ error: 'Ticker and slide deck are required' });
  }
  if (proposedLunch && !['First', 'Second', 'Both'].includes(proposedLunch)) {
    return res.status(400).json({ error: 'Invalid lunch period' });
  }
  // Start time + room are now required. Both gate the submit button on the
  // client; we re-check server-side so a manual API caller can't bypass.
  if (!proposedStartTime) {
    return res.status(400).json({ error: 'Start time is required' });
  }
  if (!room) {
    return res.status(400).json({ error: 'Room is required' });
  }
  if (!isValidRoom(room)) {
    return res.status(400).json({ error: 'Invalid room' });
  }
  // The slot must (a) match HH:MM and (b) belong to the selected lunch
  // block on the chosen weekday — anything else is rejected. We need a
  // date for that check; without one we can't validate the slot.
  if (!proposedDate) {
    return res
      .status(400)
      .json({ error: 'Proposed date is required when picking a start time' });
  }
  const weekday = weekdayKeyFor(proposedDate);
  if (!weekday) {
    return res
      .status(400)
      .json({ error: 'Pick a weekday — lunch periods only run Mon–Fri' });
  }
  if (!isValidSlot(weekday, proposedLunch || 'Both', proposedStartTime)) {
    return res
      .status(400)
      .json({ error: 'Start time is outside the chosen lunch block' });
  }
  // External URLs (Google Drive paste-link path) must pass the same SSRF
  // guard we use for pitch slideshow URLs. OneDrive refs bypass the check
  // since they're our own opaque IDs, not user-controlled URLs.
  if (!deckRef.startsWith('onedrive:')) {
    try {
      assertSafeHttpUrl(deckRef, 'Slide deck link');
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  // Resolve the PM for the chosen industry by snapshotting the leader at
  // submission time. If leadership changes later, the email recipient
  // doesn't retroactively change — the request is bound to whoever was
  // PM when the request was filed.
  let industry = null;
  let pmId = null;
  if (industryId) {
    industry = await prisma.industry.findUnique({
      where: { id: Number(industryId) },
      select: { id: true, name: true, leaderId: true },
    });
    if (!industry) {
      return res.status(400).json({ error: 'Industry not found' });
    }
    pmId = industry.leaderId || null;
  }

  const president = await findPresident();

  const created = await prisma.pitchRequest.create({
    data: {
      requesterId: req.user.id,
      ticker: String(ticker).toUpperCase(),
      companyName: companyName || null,
      thesis: thesis || null,
      industryId: industry?.id || null,
      pmId,
      proposedDate: proposedDate ? new Date(proposedDate) : null,
      proposedLunch: proposedLunch || null,
      proposedStartTime,
      room,
      notes: notes || null,
      deckRef,
      presidentId: president?.id || null,
    },
    include: pitchRequestInclude(),
  });

  await auditReq(req, 'pitch_request.create', 'PitchRequest', created.id, {
    ticker: created.ticker,
    industryId: created.industryId,
    pmId: created.pmId,
  });

  // Fan out emails in the background. We respond as soon as the row is
  // written so a slow SMTP server / OneDrive pull doesn't make the form
  // hang. Failures are logged.
  (async () => {
    const origin = primaryClientOrigin();
    const inboxUrl = `${origin}/pitch-requests`;
    const attachment = await tryBuildAttachment(deckRef);
    const externalDeckUrl = deckRef.startsWith('onedrive:') ? null : deckRef;
    const emailParams = {
      requesterName: req.user.name,
      requesterRole: req.user.role,
      ticker: created.ticker,
      companyName: created.companyName,
      industryName: industry?.name || null,
      proposedDate: created.proposedDate,
      proposedLunch: created.proposedLunch,
      proposedStartTime: created.proposedStartTime,
      room: created.room,
      notes: created.notes,
      deckUrl: externalDeckUrl,
      deckFileName: attachment?.filename || null,
      inboxUrl,
      attachment,
    };
    if (president?.email) {
      try {
        await sendPitchRequestEmail(president.email, {
          ...emailParams,
          recipientName: president.name,
          recipientRole: 'President',
        });
      } catch (err) {
        console.error(`pitch-request ${created.id} president email failed: ${err.message}`);
      }
    }
    if (pmId && pmId !== president?.id) {
      const pm = await prisma.user.findUnique({
        where: { id: pmId },
        select: { name: true, email: true },
      });
      if (pm?.email) {
        try {
          await sendPitchRequestEmail(pm.email, {
            ...emailParams,
            recipientName: pm.name,
            recipientRole: 'PM',
          });
        } catch (err) {
          console.error(`pitch-request ${created.id} PM email failed: ${err.message}`);
        }
      }
    }
    // Confirmation copy to the submitter — closes the loop on "did my
    // request go through?" without forcing them to refresh the inbox.
    // Skipped only if the submitter is also the President (they already
    // got a copy as recipientRole='President').
    if (req.user?.email && req.user.id !== president?.id) {
      try {
        await sendPitchRequestEmail(req.user.email, {
          ...emailParams,
          recipientName: req.user.name,
          recipientRole: 'Requester',
          // Don't double-attach the deck on the requester's own email
          // — they uploaded it, they don't need it back.
          attachment: null,
        });
      } catch (err) {
        console.error(`pitch-request ${created.id} requester email failed: ${err.message}`);
      }
    }
  })().catch((err) => console.error('pitch-request fan-out failed:', err));

  res.status(201).json(created);
});

// ── Inbox queries ─────────────────────────────────────────────────────

// What the requester sees on their own dashboard.
router.get('/mine', async (req, res) => {
  const rows = await prisma.pitchRequest.findMany({
    where: { requesterId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: pitchRequestInclude(),
  });
  res.json(rows);
});

// Mark a decided request as "seen" so the requester's notification chip
// goes away. Idempotent.
router.post('/mine/:id/seen', async (req, res) => {
  const id = Number(req.params.id);
  const row = await prisma.pitchRequest.findUnique({ where: { id } });
  if (!row || row.requesterId !== req.user.id) {
    return res.status(404).json({ error: 'Not found' });
  }
  await prisma.pitchRequest.update({
    where: { id },
    data: { requesterSeenAt: new Date() },
  });
  res.json({ ok: true });
});

// Pending queue for the President. Includes everything not yet decided
// regardless of PM status — the PM decision is informational, the
// President is the gating role.
router.get('/pending-for-president', async (req, res) => {
  if (req.user.role !== 'President') {
    return res.status(403).json({ error: 'President only' });
  }
  const rows = await prisma.pitchRequest.findMany({
    where: { status: 'Pending' },
    orderBy: { createdAt: 'asc' },
    include: pitchRequestInclude(),
  });
  res.json(rows);
});

// Pending queue for a PM — only requests for industries they lead and
// where they haven't recorded a decision yet. Senior PMs / CIO / President
// can also see PM queues for any pod (they sometimes triage on behalf of
// PMs who are away).
router.get('/pending-for-pm', async (req, res) => {
  const rank = ROLE_RANK[req.user.role] || 0;
  if (rank < ROLE_RANK.PortfolioManager) {
    return res.status(403).json({ error: 'PM role or higher required' });
  }
  const where = {
    status: 'Pending',
    pmDecidedAt: null,
  };
  if (rank < ROLE_RANK.SeniorPortfolioManager) {
    // Plain PM — only show requests for industries they lead.
    where.pmId = req.user.id;
  }
  const rows = await prisma.pitchRequest.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    include: pitchRequestInclude(),
  });
  res.json(rows);
});

// ── Decisions ─────────────────────────────────────────────────────────

async function emailRequesterDecision(row, { actor, actorName, decision, reason }) {
  if (!row.requester?.email) return;
  const origin = primaryClientOrigin();
  // On approval, attach an .ics so the requester's mail client offers
  // an "Add to calendar" button — meeting goes straight onto their
  // Gmail / Apple / Outlook calendar.
  let icsAttachment = null;
  if (decision === 'Approved' && row.proposedDate && row.proposedStartTime) {
    try {
      icsAttachment = buildPitchMeetingIcs({
        uid: `pitch-request-${row.id}@griffinfund`,
        proposedDate: row.proposedDate,
        proposedStartTime: row.proposedStartTime,
        ticker: row.ticker,
        companyName: row.companyName,
        roomLabel: row.room ? ROOM_LABELS[row.room] || row.room : null,
        organizerEmail: row.president?.email || null,
        organizerName: row.president?.name || 'President',
        attendeeEmails: [row.requester?.email, row.pm?.email].filter(Boolean),
      });
    } catch (err) {
      console.warn(`pitch-request ${row.id} ics build failed: ${err.message}`);
    }
  }
  const params = {
    requesterName: row.requester.name,
    actor, // 'President' | 'PM'
    actorName,
    decision, // 'Approved' | 'Declined'
    ticker: row.ticker,
    reason: reason || null,
    dashboardUrl: `${origin}/pitch-requests`,
    proposedDate: row.proposedDate,
    proposedStartTime: row.proposedStartTime,
    roomLabel: row.room ? ROOM_LABELS[row.room] || row.room : null,
    icsAttachment,
  };
  try {
    await sendPitchRequestDecisionEmail(row.requester.email, params);
  } catch (err) {
    console.error(`pitch-request ${row.id} decision email failed: ${err.message}`);
  }
  // On approval, also re-notify the PM so they can lock the meeting
  // in their own calendar — they were cc'd on the original request
  // but didn't see the time/room get confirmed until now.
  if (decision === 'Approved' && row.pm?.email && row.pm.id !== row.requester?.id) {
    try {
      await sendPitchRequestDecisionEmail(row.pm.email, {
        ...params,
        requesterName: row.pm.name, // greet the PM, not the requester
        ccCopy: true, // template tweaks copy: "for your awareness"
      });
    } catch (err) {
      console.error(`pitch-request ${row.id} PM approval email failed: ${err.message}`);
    }
  }
}

// President's decision — flips the overall status of the request.
router.post('/:id/president-decision', async (req, res) => {
  if (req.user.role !== 'President') {
    return res.status(403).json({ error: 'President only' });
  }
  const id = Number(req.params.id);
  const { approved, reason } = req.body || {};
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved (boolean) is required' });
  }
  const existing = await prisma.pitchRequest.findUnique({
    where: { id },
    include: pitchRequestInclude(),
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.status !== 'Pending') {
    return res.status(409).json({ error: 'Request already decided' });
  }

  const updated = await prisma.pitchRequest.update({
    where: { id },
    data: {
      status: approved ? 'Approved' : 'Declined',
      presidentId: req.user.id,
      presidentDecidedAt: new Date(),
      presidentDeclineReason: approved ? null : reason || null,
      // Clear any stale "seen" timestamp so the requester sees a fresh
      // notification on their dashboard.
      requesterSeenAt: null,
    },
    include: pitchRequestInclude(),
  });

  await auditReq(
    req,
    approved ? 'pitch_request.approve' : 'pitch_request.decline',
    'PitchRequest',
    id,
    { ticker: updated.ticker, reason: reason || null }
  );

  emailRequesterDecision(updated, {
    actor: 'President',
    actorName: req.user.name,
    decision: approved ? 'Approved' : 'Declined',
    reason: approved ? null : reason,
  }).catch(() => {});

  res.json(updated);
});

// PM decision — informational. Doesn't change status.
router.post('/:id/pm-decision', async (req, res) => {
  const rank = ROLE_RANK[req.user.role] || 0;
  if (rank < ROLE_RANK.PortfolioManager) {
    return res.status(403).json({ error: 'PM role or higher required' });
  }
  const id = Number(req.params.id);
  const { approved, reason } = req.body || {};
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved (boolean) is required' });
  }
  const existing = await prisma.pitchRequest.findUnique({
    where: { id },
    include: pitchRequestInclude(),
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Plain PMs can only decide on their own pod's requests.
  if (
    rank < ROLE_RANK.SeniorPortfolioManager &&
    existing.pmId !== req.user.id
  ) {
    return res.status(403).json({ error: 'Not your pod' });
  }
  if (existing.status !== 'Pending') {
    return res.status(409).json({ error: 'Request already decided' });
  }

  const updated = await prisma.pitchRequest.update({
    where: { id },
    data: {
      pmDecidedAt: new Date(),
      pmApproved: approved,
      pmDeclineReason: approved ? null : reason || null,
    },
    include: pitchRequestInclude(),
  });

  await auditReq(
    req,
    approved ? 'pitch_request.pm_approve' : 'pitch_request.pm_decline',
    'PitchRequest',
    id,
    { ticker: updated.ticker, reason: reason || null }
  );

  // Only notify the requester when the PM CAN'T make it — an approval is
  // expected and inbox-noisy. The President's decision (which actually
  // gates the meeting) is the email worth firing.
  if (!approved) {
    emailRequesterDecision(updated, {
      actor: 'PM',
      actorName: req.user.name,
      decision: 'Declined',
      reason,
    }).catch(() => {});
  }

  res.json(updated);
});

// Pending count for the navbar badge — cheap polling endpoint, returns
// just the number relevant to the caller.
router.get('/pending-count', async (req, res) => {
  const rank = ROLE_RANK[req.user.role] || 0;
  let count = 0;
  if (req.user.role === 'President') {
    count = await prisma.pitchRequest.count({ where: { status: 'Pending' } });
  } else if (rank >= ROLE_RANK.PortfolioManager) {
    const where = { status: 'Pending', pmDecidedAt: null };
    if (rank < ROLE_RANK.SeniorPortfolioManager) where.pmId = req.user.id;
    count = await prisma.pitchRequest.count({ where });
  }
  // Plus undismissed decisions for the requester themselves.
  const mineUnseen = await prisma.pitchRequest.count({
    where: {
      requesterId: req.user.id,
      status: { in: ['Approved', 'Declined'] },
      requesterSeenAt: null,
    },
  });
  res.json({ count, mineUnseen });
});

// Approved pitch-meetings the current user is part of — used by the
// Calendar page so each meeting lands on the involved parties' (and
// only their) calendars. Scoped server-side so unrelated members
// can't see meetings they aren't in.
router.get('/calendar', async (req, res) => {
  const userId = req.user.id;
  const rows = await prisma.pitchRequest.findMany({
    where: {
      status: 'Approved',
      proposedDate: { not: null },
      proposedStartTime: { not: null },
      OR: [
        { requesterId: userId },
        { pmId: userId },
        { presidentId: userId },
      ],
    },
    orderBy: { proposedDate: 'asc' },
    include: pitchRequestInclude(),
  });
  res.json(rows);
});

export default router;
