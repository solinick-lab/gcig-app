import { Router } from 'express';
import prisma from '../db.js';
import { verifyJwt, requireRole } from '../middleware/auth.js';
import { sendPitchAssignmentEmail } from '../services/email.js';
import { assertSafeHttpUrl } from '../services/validateUrl.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

const canEditPitches = requireRole('PortfolioManager');

const router = Router();
router.use(verifyJwt);

function pitchInclude() {
  return {
    presenters: {
      include: { user: { select: { id: true, name: true, email: true, role: true } } },
    },
    industry: {
      select: {
        id: true,
        name: true,
        leader: { select: { id: true, name: true, role: true } },
        members: {
          include: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        },
      },
    },
  };
}

function shapePitch(p) {
  if (!p) return p;
  const { presenters = [], industry, ...rest } = p;
  return {
    ...rest,
    presenters: presenters.map((pp) => pp.user),
    industry: industry
      ? {
          id: industry.id,
          name: industry.name,
          leader: industry.leader,
          members: industry.members.map((m) => m.user),
        }
      : null,
  };
}

router.get('/', async (_req, res) => {
  const pitches = await prisma.pitch.findMany({
    orderBy: { date: 'desc' },
    include: pitchInclude(),
  });
  res.json(pitches.map(shapePitch));
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pitch = await prisma.pitch.findUnique({ where: { id }, include: pitchInclude() });
  if (!pitch) return res.status(404).json({ error: 'Not found' });
  res.json(shapePitch(pitch));
});

// Pitches I'm presenting that are in the future and I haven't dismissed.
// Outcomes for every pitch that became a position — buy price, current
// price, return. Also rolls up a per-presenter hit rate for the leaderboard.
//
// Buy price selection:
//   1. The HoldingLot whose buyDate is closest to the pitch date (within ±90d)
//   2. Falls back to the holding's avg cost from the sheet
router.get('/outcomes/all', async (_req, res) => {
  try {
    const [pitches, reports, portfolio, lots] = await Promise.all([
      prisma.pitch.findMany({
        orderBy: { date: 'desc' },
        include: {
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.report.findMany({
        where: { ticker: { not: null } },
        orderBy: { date: 'desc' },
      }),
      getSheetPortfolio().catch(() => null),
      prisma.holdingLot.findMany(),
    ]);

    const holdingsByTicker = new Map();
    for (const h of portfolio?.holdings || []) {
      if (!h.isCash) holdingsByTicker.set(h.ticker.toUpperCase(), h);
    }

    // True weighted-avg cost across every lot we have for a ticker. Falls back
    // to the sheet's costBasis (also blended) if no lots are seeded yet. Used
    // instead of the "nearest lot" heuristic so a pitcher's return reflects
    // the WHOLE position they're responsible for, including later add-ons.
    function blendedCost(ticker) {
      const t = ticker.toUpperCase();
      const tickerLots = lots.filter((l) => l.ticker.toUpperCase() === t);
      if (tickerLots.length === 0) return null;
      let shares = 0;
      let cost = 0;
      for (const l of tickerLots) {
        shares += l.shares;
        cost += l.shares * l.pricePerShare;
      }
      return shares > 0 ? cost / shares : null;
    }

    function outcomeFor(ticker, refDate) {
      const t = (ticker || '').toUpperCase();
      const h = holdingsByTicker.get(t);
      // Prefer the sheet's blended return when available — it already factors
      // in every lot currently held. Otherwise derive from lots or fall back
      // to cost basis math.
      const buyPrice = blendedCost(t) ?? h?.costBasis ?? null;
      const currentPrice = h?.price ?? null;
      const percent =
        h?.percentReturn != null
          ? h.percentReturn
          : buyPrice != null && currentPrice != null && buyPrice > 0
          ? ((currentPrice - buyPrice) / buyPrice) * 100
          : null;
      return { ticker: t, holding: h, buyPrice, currentPrice, percent };
    }

    // Split author strings like "Jane Doe, John Smith" or "Jane Doe & John Smith"
    // so each listed member gets credit for the report.
    function splitAuthors(author) {
      if (!author) return [];
      return String(author)
        .split(/[,&]|\band\b/i)
        .map((s) => s.trim())
        .filter(Boolean);
    }

    const pitchResults = pitches.map((p) => {
      const o = outcomeFor(p.ticker, p.date);
      const presenters =
        p.presenters.length > 0
          ? p.presenters.map((pp) => ({ id: pp.user.id, name: pp.user.name }))
          : [{ id: null, name: p.pitcherName }];
      return {
        id: `pitch-${p.id}`,
        type: 'pitch',
        ticker: o.ticker,
        date: p.date,
        presenters,
        industry: p.industryId,
        isPosition: !!o.holding,
        votedOutcome: p.votedOutcome,
        buyPrice: o.buyPrice,
        buyDate: null,
        currentPrice: o.currentPrice,
        percent: o.percent,
      };
    });

    const reportResults = reports.map((r) => {
      const o = outcomeFor(r.ticker, r.date);
      const presenters = splitAuthors(r.author).map((name) => ({ id: null, name }));
      return {
        id: `report-${r.id}`,
        type: 'report',
        ticker: o.ticker,
        title: r.title,
        date: r.date,
        presenters:
          presenters.length > 0 ? presenters : [{ id: null, name: r.author || 'Unknown' }],
        industry: null,
        isPosition: !!o.holding,
        buyPrice: o.buyPrice,
        buyDate: null,
        currentPrice: o.currentPrice,
        percent: o.percent,
      };
    });

    // A row is "tracked" if we have any club decision recorded: either the
    // ticker is in the current portfolio (isPosition) OR it was voted on.
    function stamp(r) {
      r.hasOutcome = r.isPosition || !!r.votedOutcome;
      return r;
    }
    const results = [...pitchResults.map(stamp), ...reportResults.map(stamp)].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    // Hit rate = pitches the club voted YES to (bought). A pitch "won a vote"
    // if it became a position or was explicitly marked votedOutcome='Buy'.
    // A pitch "lost a vote" if votedOutcome='NoBuy'. Pitches with neither
    // signal (no decision yet) don't count in the denominator.
    function pitchDecision(r) {
      if (r.type !== 'pitch') return null;
      if (r.isPosition || r.votedOutcome === 'Buy') return 'buy';
      if (r.votedOutcome === 'NoBuy') return 'nobuy';
      return null;
    }

    // Roll up per-presenter: avg return uses rows with a real $ return, hit
    // rate uses voted-on pitches (buys / (buys + nobuys)).
    const byPresenter = new Map();
    function ensure(key, p) {
      if (!byPresenter.has(key)) {
        byPresenter.set(key, {
          name: p.name,
          id: p.id,
          returnRows: 0,
          totalReturn: 0,
          buys: 0,
          noBuys: 0,
        });
      }
      return byPresenter.get(key);
    }
    for (const r of results) {
      // Average return contributions.
      if (r.isPosition && r.percent != null) {
        for (const p of r.presenters) {
          const agg = ensure(p.name, p);
          agg.returnRows += 1;
          agg.totalReturn += r.percent;
        }
      }
      // Hit-rate contributions (pitches only).
      const decision = pitchDecision(r);
      if (decision) {
        for (const p of r.presenters) {
          const agg = ensure(p.name, p);
          if (decision === 'buy') agg.buys += 1;
          else agg.noBuys += 1;
        }
      }
    }
    const leaderboard = [...byPresenter.values()]
      .map((a) => {
        const voted = a.buys + a.noBuys;
        return {
          ...a,
          pitches: voted,
          avgReturn: a.returnRows > 0 ? a.totalReturn / a.returnRows : 0,
          hitRate: voted > 0 ? a.buys / voted : 0,
        };
      })
      .sort((a, b) => b.avgReturn - a.avgReturn);

    // Club-wide averages.
    const withReturn = results.filter((r) => r.isPosition && r.percent != null);
    const clubAvg =
      withReturn.length > 0
        ? withReturn.reduce((s, r) => s + r.percent, 0) / withReturn.length
        : 0;
    const clubBuys = results.filter((r) => pitchDecision(r) === 'buy').length;
    const clubNoBuys = results.filter((r) => pitchDecision(r) === 'nobuy').length;
    const clubVoted = clubBuys + clubNoBuys;
    const clubHitRate = clubVoted > 0 ? clubBuys / clubVoted : 0;

    res.json({
      results,
      leaderboard,
      clubAvg,
      clubHitRate,
      trackedCount: results.filter((r) => r.hasOutcome).length,
    });
  } catch (err) {
    console.error('pitch outcomes failed:', err);
    res.status(500).json({ error: 'Failed to compute outcomes' });
  }
});

// Personal outcome stats for the logged-in user. Mirrors /outcomes/all but
// filtered to pitches + reports the user is tied to (presenter or author).
router.get('/outcomes/mine', async (req, res) => {
  try {
    const [myPitches, reports, portfolio, lots, me] = await Promise.all([
      prisma.pitch.findMany({
        where: { presenters: { some: { userId: req.user.id } } },
        orderBy: { date: 'desc' },
        include: {
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      }),
      prisma.report.findMany({
        where: { ticker: { not: null } },
        orderBy: { date: 'desc' },
      }),
      getSheetPortfolio().catch(() => null),
      prisma.holdingLot.findMany(),
      prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } }),
    ]);

    const holdingsByTicker = new Map();
    for (const h of portfolio?.holdings || []) {
      if (!h.isCash) holdingsByTicker.set(h.ticker.toUpperCase(), h);
    }
    function blendedCost(ticker) {
      const t = ticker.toUpperCase();
      const tickerLots = lots.filter((l) => l.ticker.toUpperCase() === t);
      if (tickerLots.length === 0) return null;
      let shares = 0;
      let cost = 0;
      for (const l of tickerLots) {
        shares += l.shares;
        cost += l.shares * l.pricePerShare;
      }
      return shares > 0 ? cost / shares : null;
    }
    function outcomeFor(ticker, refDate) {
      const t = (ticker || '').toUpperCase();
      const h = holdingsByTicker.get(t);
      const buyPrice = blendedCost(t) ?? h?.costBasis ?? null;
      const currentPrice = h?.price ?? null;
      const percent =
        h?.percentReturn != null
          ? h.percentReturn
          : buyPrice != null && currentPrice != null && buyPrice > 0
          ? ((currentPrice - buyPrice) / buyPrice) * 100
          : null;
      return { ticker: t, holding: h, buyPrice, currentPrice, percent };
    }

    const pitchRows = myPitches.map((p) => {
      const o = outcomeFor(p.ticker, p.date);
      return {
        id: `pitch-${p.id}`,
        type: 'pitch',
        ticker: o.ticker,
        date: p.date,
        isPosition: !!o.holding,
        votedOutcome: p.votedOutcome,
        buyPrice: o.buyPrice,
        currentPrice: o.currentPrice,
        percent: o.percent,
      };
    });

    // Reports where my name appears in the author field.
    const myName = (me?.name || '').toLowerCase();
    const myReports = myName
      ? reports.filter((r) =>
          (r.author || '')
            .split(/[,&]|\band\b/i)
            .map((s) => s.trim().toLowerCase())
            .includes(myName)
        )
      : [];
    const reportRows = myReports.map((r) => {
      const o = outcomeFor(r.ticker, r.date);
      return {
        id: `report-${r.id}`,
        type: 'report',
        ticker: o.ticker,
        title: r.title,
        date: r.date,
        isPosition: !!o.holding,
        votedOutcome: null,
        buyPrice: o.buyPrice,
        currentPrice: o.currentPrice,
        percent: o.percent,
      };
    });

    const rows = [...pitchRows, ...reportRows].sort(
      (a, b) => new Date(b.date) - new Date(a.date)
    );

    const withReturn = rows.filter((r) => r.isPosition && r.percent != null);
    const avgReturn =
      withReturn.length > 0
        ? withReturn.reduce((s, r) => s + r.percent, 0) / withReturn.length
        : 0;
    const totalPitches = myPitches.length;
    const pitchesVotedNo = myPitches.filter((p) => p.votedOutcome === 'NoBuy').length;
    // A pitch "won a vote" if it's a current position OR was explicitly
    // voted Buy. Hit rate = buys / (buys + nobuys). Pitches with no
    // decision yet don't count either way.
    const myBuys = pitchRows.filter(
      (r) => r.isPosition || r.votedOutcome === 'Buy'
    ).length;
    const myVoted = myBuys + pitchesVotedNo;
    const hitRate = myVoted > 0 ? myBuys / myVoted : 0;

    res.json({
      rows,
      totalPitches,
      totalReports: myReports.length,
      positionsCount: withReturn.length,
      pitchesVotedNo,
      pitchesVotedBuy: myBuys,
      avgReturn,
      hitRate,
    });
  } catch (err) {
    console.error('outcomes/mine failed:', err);
    res.status(500).json({ error: 'Failed to compute personal outcomes' });
  }
});

router.get('/mine/upcoming', async (req, res) => {
  const now = new Date();
  const rows = await prisma.pitchPresenter.findMany({
    where: {
      userId: req.user.id,
      seenAt: null,
      pitch: { date: { gte: now } },
    },
    include: {
      pitch: {
        include: {
          presenters: {
            include: { user: { select: { id: true, name: true } } },
          },
        },
      },
    },
    orderBy: { assignedAt: 'desc' },
  });
  res.json(
    rows.map((r) => ({
      pitchId: r.pitchId,
      assignedAt: r.assignedAt,
      pitch: {
        ...r.pitch,
        presenters: r.pitch.presenters.map((pp) => pp.user),
      },
    }))
  );
});

// Mark my assignment as seen (dismisses popup).
router.post('/mine/seen/:pitchId', async (req, res) => {
  const pitchId = Number(req.params.pitchId);
  await prisma.pitchPresenter.updateMany({
    where: { pitchId, userId: req.user.id },
    data: { seenAt: new Date() },
  });
  res.json({ ok: true });
});

async function notifyUsers(pitch, userIds, clientOrigin) {
  if (userIds.length === 0) return;
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  });
  const allPresenters = await prisma.pitchPresenter.findMany({
    where: { pitchId: pitch.id },
    include: { user: { select: { name: true } } },
  });
  const industry = pitch.industryId
    ? await prisma.industry.findUnique({ where: { id: pitch.industryId } })
    : null;
  const presenterNames = allPresenters.map((p) => p.user.name).join(', ');
  const pitcherDisplay =
    industry && !presenterNames
      ? `${industry.name} pod`
      : presenterNames || pitch.pitcherName || 'TBD';

  await Promise.all(
    users.map(async (u) => {
      try {
        await sendPitchAssignmentEmail(u.email, {
          name: u.name,
          ticker: pitch.ticker,
          pitcherDisplay,
          date: pitch.date,
          location: pitch.location,
          dashboardUrl: clientOrigin,
        });
        console.log(`[pitch ${pitch.id}] email sent to ${u.email}`);
      } catch (err) {
        console.error(
          `[pitch ${pitch.id}] email to ${u.email} FAILED:`,
          err.message || err
        );
      }
    })
  );
}

// Cross-pod scheduling privileges. Presidents, CIOs, and SPMs can schedule
// for any industry; Portfolio Managers can only schedule for their own pod.
const CROSS_POD_ROLES = new Set(['President', 'CIO', 'SeniorPortfolioManager']);

async function assertCanUseIndustry(req, industryId) {
  if (!industryId) return; // individual pitch — always OK
  if (CROSS_POD_ROLES.has(req.user.role)) return;
  const industry = await prisma.industry.findUnique({
    where: { id: Number(industryId) },
    select: { leaderId: true },
  });
  if (!industry || industry.leaderId !== req.user.id) {
    const err = new Error("You can only schedule pitches for industries you lead");
    err.status = 403;
    throw err;
  }
}

router.post('/', canEditPitches, async (req, res, next) => {
  const { pitcherName, ticker, date, location, slideshowUrl, presenterIds, industryId } = req.body;
  if (!ticker || !date) {
    return res.status(400).json({ error: 'ticker and date required' });
  }
  try {
    assertSafeHttpUrl(slideshowUrl, 'Slideshow link');
    await assertCanUseIndustry(req, industryId);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  const ids = Array.isArray(presenterIds) ? presenterIds.map(Number).filter(Boolean) : [];

  const pitch = await prisma.pitch.create({
    data: {
      pitcherName: pitcherName || '',
      ticker: ticker.toUpperCase(),
      date: new Date(date),
      location: location || null,
      slideshowUrl: slideshowUrl || null,
      industryId: industryId ? Number(industryId) : null,
      presenters: ids.length
        ? { create: ids.map((userId) => ({ userId })) }
        : undefined,
    },
    include: pitchInclude(),
  });

  // Notify everyone who should know: explicit presenters + all members of
  // the assigned industry (deduped). The creator is included so they get
  // a confirmation copy — useful for both verifying delivery and giving the
  // President a record of what they scheduled.
  const recipientIds = new Set(ids);
  if (pitch.industryId) {
    const podMembers = await prisma.userIndustry.findMany({
      where: { industryId: pitch.industryId },
      select: { userId: true },
    });
    for (const m of podMembers) recipientIds.add(m.userId);
  }
  console.log(
    `[pitch ${pitch.id}] notifying ${recipientIds.size} recipient(s) for ${pitch.ticker}`
  );

  notifyUsers(
    pitch,
    [...recipientIds],
    process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com'
  ).catch(() => {});

  // Ensure industry members also get the in-app PitchNotification popup.
  if (recipientIds.size > 0) {
    await prisma.pitchPresenter.createMany({
      data: [...recipientIds].map((userId) => ({ pitchId: pitch.id, userId })),
      skipDuplicates: true,
    });
  }

  // Re-fetch to include the full presenter list in the response.
  const fresh = await prisma.pitch.findUnique({
    where: { id: pitch.id },
    include: pitchInclude(),
  });
  res.status(201).json(shapePitch(fresh));
});

router.put('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({
    where: { id },
    include: { presenters: true },
  });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { pitcherName, ticker, date, location, slideshowUrl, presenterIds, industryId } = req.body;
  if (slideshowUrl !== undefined) {
    try {
      assertSafeHttpUrl(slideshowUrl, 'Slideshow link');
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // Portfolio Managers can only edit pitches that belong to their own pod,
  // and can't reassign a pitch to another pod. President/CIO/SPM may edit
  // any pitch.
  if (!CROSS_POD_ROLES.has(req.user.role)) {
    const targetIndustry =
      industryId !== undefined ? industryId : existing.industryId;
    try {
      await assertCanUseIndustry(req, targetIndustry);
      // Also verify they lead the CURRENT industry (so they can't edit a
      // pitch that belongs to someone else's pod).
      await assertCanUseIndustry(req, existing.industryId);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }
  const data = {};
  if (pitcherName !== undefined) data.pitcherName = pitcherName;
  if (ticker !== undefined) data.ticker = ticker.toUpperCase();
  if (date !== undefined) data.date = new Date(date);
  if (location !== undefined) data.location = location || null;
  if (slideshowUrl !== undefined) data.slideshowUrl = slideshowUrl || null;
  if (industryId !== undefined) data.industryId = industryId ? Number(industryId) : null;

  let newPresenterIds = [];
  if (Array.isArray(presenterIds)) {
    const desired = new Set(presenterIds.map(Number).filter(Boolean));
    const current = new Set(existing.presenters.map((p) => p.userId));
    const toAdd = [...desired].filter((x) => !current.has(x));
    const toRemove = [...current].filter((x) => !desired.has(x));
    newPresenterIds = toAdd;

    await prisma.$transaction([
      ...(toRemove.length
        ? [
            prisma.pitchPresenter.deleteMany({
              where: { pitchId: id, userId: { in: toRemove } },
            }),
          ]
        : []),
      ...toAdd.map((userId) =>
        prisma.pitchPresenter.create({ data: { pitchId: id, userId } })
      ),
    ]);
  }

  const pitch = await prisma.pitch.update({
    where: { id },
    data,
    include: pitchInclude(),
  });

  // Figure out everyone to notify:
  //   - new explicit presenters (from the presenterIds diff above)
  //   - pod members of a NEWLY-ATTACHED industry (when industryId changed
  //     from null/other to a real value)
  // Deduped, excluding the editor themselves and anyone already on the pitch
  // (they were notified when originally added).
  const toNotify = new Set(newPresenterIds);
  const industryChanged =
    industryId !== undefined &&
    (pitch.industryId || null) !== (existing.industryId || null);
  if (industryChanged && pitch.industryId) {
    const podMembers = await prisma.userIndustry.findMany({
      where: { industryId: pitch.industryId },
      select: { userId: true },
    });
    const previouslyNotified = new Set(existing.presenters.map((p) => p.userId));
    for (const m of podMembers) {
      if (!previouslyNotified.has(m.userId)) toNotify.add(m.userId);
    }
  }
  console.log(
    `[pitch ${pitch.id}] edit — notifying ${toNotify.size} new recipient(s)`
  );

  if (toNotify.size > 0) {
    // Create PitchPresenter rows so the in-app popup fires on next page load.
    await prisma.pitchPresenter.createMany({
      data: [...toNotify].map((userId) => ({ pitchId: id, userId })),
      skipDuplicates: true,
    });
    notifyUsers(
      pitch,
      [...toNotify],
      process.env.CLIENT_ORIGIN || 'https://gcig-client.onrender.com'
    ).catch(() => {});
  }

  // Re-fetch so the response includes the newly-added pod members.
  const fresh = await prisma.pitch.findUnique({
    where: { id },
    include: pitchInclude(),
  });
  res.json(shapePitch(fresh));
});

router.delete('/:id', canEditPitches, async (req, res) => {
  const id = Number(req.params.id);
  const existing = await prisma.pitch.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await prisma.pitch.delete({ where: { id } });
  res.json({ ok: true });
});

export default router;
