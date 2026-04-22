import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from '../db.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';

// Builds the system prompt for the AI Sandbox. Combines:
//   1. A tight scope directive (investing + Griffin Fund only)
//   2. The club's IPS and Internal Policies docs (verbatim, as reference)
//   3. Live club data (portfolio, votes, pitches, events) pulled on demand
//
// The assembled brief is cached for 60s so a burst of messages doesn't
// hammer the Google Sheet / Prisma. Cache misses fall through gracefully —
// if the sheet is unreachable we still return the doc-only brief.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the reference docs once at startup. They don't change at runtime
// (IPS requires CFO + Advisory Board approval to amend).
const IPS_TEXT = fs.readFileSync(path.join(__dirname, 'ips.md'), 'utf8');
const INTERNAL_POLICIES_TEXT = fs.readFileSync(
  path.join(__dirname, 'internal-policies.md'),
  'utf8'
);

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, text: null };

// Truncate a list to N items with a tail indicator.
function cap(items, n) {
  if (items.length <= n) return items;
  return [...items.slice(0, n), `…(+${items.length - n} more)`];
}

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(1)}%`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toISOString().slice(0, 10);
}

// Keep any per-ticker thesis text under this so we don't balloon the
// system prompt. The model doesn't need the whole 3-page write-up — it
// needs the gist.
const MAX_THESIS_CHARS = 800;

function truncate(s, n) {
  if (!s) return '';
  const t = String(s).trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '…';
}

async function buildLiveContext() {
  const now = new Date();
  const in14 = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const days30Ago = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // First pass: grab sheet + baseline Prisma data in parallel.
  const [
    sheetRes,
    openVotes,
    closedVotes,
    upcomingPitches,
    upcomingEvents,
  ] = await Promise.allSettled([
    getSheetPortfolio(),
    prisma.votingSession.findMany({
      where: { status: 'open' },
      orderBy: { deadline: 'asc' },
      select: { ticker: true, title: true, deadline: true },
    }),
    prisma.votingSession.findMany({
      where: { status: 'closed', closedAt: { gte: days30Ago } },
      orderBy: { closedAt: 'desc' },
      take: 8,
      select: { ticker: true, title: true, closedAt: true },
    }),
    prisma.pitch.findMany({
      where: { date: { gte: now, lte: in14 } },
      orderBy: { date: 'asc' },
      take: 8,
      select: { ticker: true, pitcherName: true, date: true },
    }),
    prisma.event.findMany({
      where: { date: { gte: now, lte: in14 }, audience: 'all' },
      orderBy: { date: 'asc' },
      take: 8,
      select: { title: true, date: true, location: true },
    }),
  ]);

  // Held tickers → used to pull per-ticker thesis + pitch history so the
  // model can answer "tell me about NOC" with our actual coverage.
  const heldTickers =
    sheetRes.status === 'fulfilled' && sheetRes.value
      ? sheetRes.value.holdings
          .filter((h) => !h.isCash && h.ticker)
          .map((h) => h.ticker.toUpperCase())
      : [];

  const [thesesRes, pitchHistoryRes, closedVotesForHoldingsRes] =
    heldTickers.length > 0
      ? await Promise.allSettled([
          prisma.holdingThesis.findMany({
            where: { ticker: { in: heldTickers } },
            select: {
              ticker: true,
              thesis: true,
              updatedByName: true,
              updatedAt: true,
            },
          }),
          prisma.pitch.findMany({
            where: { ticker: { in: heldTickers } },
            orderBy: { date: 'desc' },
            select: {
              ticker: true,
              pitcherName: true,
              date: true,
              votedOutcome: true,
            },
          }),
          prisma.votingSession.findMany({
            where: { ticker: { in: heldTickers }, status: 'closed' },
            orderBy: { closedAt: 'desc' },
            select: { ticker: true, title: true, closedAt: true, synthesis: true },
          }),
        ])
      : [
          { status: 'fulfilled', value: [] },
          { status: 'fulfilled', value: [] },
          { status: 'fulfilled', value: [] },
        ];

  const thesisByTicker = new Map();
  if (thesesRes.status === 'fulfilled') {
    for (const t of thesesRes.value) {
      thesisByTicker.set(t.ticker.toUpperCase(), t);
    }
  }
  const pitchesByTicker = new Map();
  if (pitchHistoryRes.status === 'fulfilled') {
    for (const p of pitchHistoryRes.value) {
      const key = p.ticker.toUpperCase();
      if (!pitchesByTicker.has(key)) pitchesByTicker.set(key, []);
      pitchesByTicker.get(key).push(p);
    }
  }
  const closedVotesByTicker = new Map();
  if (closedVotesForHoldingsRes.status === 'fulfilled') {
    for (const v of closedVotesForHoldingsRes.value) {
      const key = v.ticker.toUpperCase();
      if (!closedVotesByTicker.has(key)) closedVotesByTicker.set(key, []);
      closedVotesByTicker.get(key).push(v);
    }
  }

  // Portfolio summary + full holdings block with company names.
  let portfolioBlock = '_Portfolio data unavailable (sheet unreachable)._';
  let intelBlock = '';
  if (sheetRes.status === 'fulfilled' && sheetRes.value) {
    const { holdings, totals } = sheetRes.value;
    const nonCash = holdings
      .filter((h) => !h.isCash && h.ticker)
      .sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

    const summaryLines = [
      `- Total portfolio value: **${fmtMoney(totals.totalValue)}**`,
      `- Cash / cash equivalents: **${fmtMoney(totals.cashValue)}** (${fmtPct(
        totals.totalValue > 0 ? (totals.cashValue / totals.totalValue) * 100 : 0
      )})`,
      `- Equity positions: **${nonCash.length}**`,
      '',
      'Current equity holdings (ordered by market value):',
    ];
    const heldLines = cap(
      nonCash.map((h) => {
        const label = h.name && h.name !== h.ticker ? `${h.ticker} — ${h.name}` : h.ticker;
        const bits = [`${fmtMoney(h.marketValue)}`];
        if (h.portfolioPct != null) bits.push(`${fmtPct(h.portfolioPct)} of portfolio`);
        if (h.sector) bits.push(h.sector);
        return `  - **${label}** — ${bits.join(', ')}`;
      }),
      20
    );
    summaryLines.push(...heldLines);
    portfolioBlock = summaryLines.join('\n');

    // Per-holding coverage: thesis + pitch history + prior vote outcomes.
    // This is the section that turns "tell me about NOC" into a real
    // answer about Northrop Grumman and what we've written up, not a
    // hallucinated guess about Northern Oil & Gas.
    const intelSections = [];
    for (const h of nonCash) {
      const ticker = h.ticker.toUpperCase();
      const theses = thesisByTicker.get(ticker);
      const pitches = pitchesByTicker.get(ticker) || [];
      const votes = closedVotesByTicker.get(ticker) || [];
      // Only render an intel block if we actually have club-sourced content
      // on the ticker — no point dumping empty scaffolding.
      if (!theses && pitches.length === 0 && votes.length === 0) continue;

      const lines = [];
      const label = h.name && h.name !== h.ticker ? `${h.ticker} — ${h.name}` : h.ticker;
      lines.push(`**${label}**${h.sector ? ` · ${h.sector}` : ''}`);

      if (theses) {
        const authorBit = theses.updatedByName ? ` (by ${theses.updatedByName})` : '';
        lines.push(
          `  - Thesis${authorBit}: ${truncate(theses.thesis, MAX_THESIS_CHARS)}`
        );
      }
      if (pitches.length > 0) {
        const pitchSummary = pitches
          .slice(0, 3)
          .map((p) => {
            const outcome = p.votedOutcome
              ? ` → ${p.votedOutcome}`
              : '';
            return `${p.pitcherName || 'TBD'} on ${fmtDate(p.date)}${outcome}`;
          })
          .join('; ');
        const more = pitches.length > 3 ? ` (+${pitches.length - 3} earlier)` : '';
        lines.push(`  - Pitched by: ${pitchSummary}${more}`);
      }
      if (votes.length > 0) {
        const v = votes[0];
        const extra = votes.length > 1 ? ` (+${votes.length - 1} earlier)` : '';
        const synth = v.synthesis ? ` — ${truncate(v.synthesis, 260)}` : '';
        lines.push(
          `  - Last vote: ${v.title || 'vote'} closed ${fmtDate(v.closedAt)}${synth}${extra}`
        );
      }
      intelSections.push(lines.join('\n'));
    }
    if (intelSections.length > 0) {
      intelBlock = intelSections.join('\n\n');
    } else {
      intelBlock =
        '_No internal thesis / pitch / vote records on file for current holdings yet._';
    }
  }

  // Open votes.
  let openBlock = '_No open votes right now._';
  if (openVotes.status === 'fulfilled' && openVotes.value.length > 0) {
    openBlock = openVotes.value
      .map(
        (v) =>
          `- **${v.ticker}** — ${v.title || 'vote'} (closes ${fmtDate(v.deadline)})`
      )
      .join('\n');
  }

  // Recently closed votes (last 30d).
  let recentVotesBlock = '_No votes closed in the last 30 days._';
  if (closedVotes.status === 'fulfilled' && closedVotes.value.length > 0) {
    recentVotesBlock = closedVotes.value
      .map(
        (v) =>
          `- **${v.ticker}** — ${v.title || 'vote'} (closed ${fmtDate(v.closedAt)})`
      )
      .join('\n');
  }

  // Upcoming pitches.
  let pitchesBlock = '_No pitches scheduled in the next 2 weeks._';
  if (upcomingPitches.status === 'fulfilled' && upcomingPitches.value.length > 0) {
    pitchesBlock = upcomingPitches.value
      .map(
        (p) =>
          `- ${fmtDate(p.date)} — **${p.ticker}** by ${p.pitcherName || 'TBD'}`
      )
      .join('\n');
  }

  // Upcoming events (non-advisory only; advisory events stay internal to the board).
  let eventsBlock = '_No events scheduled in the next 2 weeks._';
  if (upcomingEvents.status === 'fulfilled' && upcomingEvents.value.length > 0) {
    eventsBlock = upcomingEvents.value
      .map(
        (e) =>
          `- ${fmtDate(e.date)} — ${e.title}${e.location ? ` (${e.location})` : ''}`
      )
      .join('\n');
  }

  return [
    `## Live Club Data (as of ${now.toISOString()})`,
    '',
    '### Portfolio',
    portfolioBlock,
    '',
    '### Holdings Intel',
    '_Per-ticker coverage from our own records. When a user asks about a_',
    '_held ticker, use THIS as the source of truth — never invent a_',
    '_company name from a ticker symbol alone._',
    '',
    intelBlock,
    '',
    '### Open Votes',
    openBlock,
    '',
    '### Recently Closed Votes (last 30 days)',
    recentVotesBlock,
    '',
    '### Upcoming Pitches (next 2 weeks)',
    pitchesBlock,
    '',
    '### Upcoming Events (next 2 weeks)',
    eventsBlock,
  ].join('\n');
}

const SCOPE_DIRECTIVE = `You are the Griffin Fund Assistant — an in-house AI tool for Grace Church School's student-led Investment Group ("The Griffin Fund" / GCS Investment Group).

## Scope — STRICT
You ONLY answer questions about:
  1. **Investing, finance, and markets** — valuation, sector analysis, portfolio theory, specific tickers, macro, etc.
  2. **The Griffin Fund itself** — its IPS, internal policies, members, roles, current holdings, votes, pitches, events.

If a user asks about anything unrelated (general trivia, homework help, coding, personal advice, politics, entertainment, etc.), politely decline in one or two sentences and redirect them: "I'm scoped to investing topics and the Griffin Fund — happy to help with either." Do not answer off-topic questions even if the user insists.

## Style
- Concise and professional. Default to plain prose, not bullet spam.
- When citing fund policy, reference the IPS or Internal Policies by name.
- When citing live data (holdings, votes), note it as current-as-of-now.
- **Do NOT append boilerplate disclaimers** like "consult a financial advisor", "this is not financial advice", or "do your own research". The user knows this is an AI tool and an educational club — they don't need the reminder on every reply.

## Ticker disambiguation — CRITICAL
When a user asks about a ticker (e.g. "tell me about NOC"), first check the **Live Club Data → Portfolio** section. If the ticker is in our holdings, the company is the one listed there — do NOT guess from the letters alone. Example: our "NOC" is Northrop Grumman (Industrials), not Northern Oil & Gas. Always use the company name printed next to the ticker in the holdings list.

If the ticker isn't in our holdings and the user doesn't specify, ask them which company they mean rather than picking one.

## Answering about held tickers
When asked about a ticker we hold ("tell me about X", "what's our thesis on X", "who pitched X"):
  1. Start with our own coverage from **Holdings Intel**: the thesis (if any), who pitched it, when, and how the vote went.
  2. Then add market context you know about the actual company (the one named in the holdings list).
  3. If we have no internal thesis / pitch / vote records, say so explicitly before giving generic commentary.

## Authority of sources
If the IPS and Internal Policies differ on an operational detail (e.g. vote counts, role names), the **Internal Policies document is authoritative** — it reflects how the club actually runs. The app itself uses role names like "JuniorAnalyst", "Analyst", "PortfolioManager" (matching the Internal Policies) rather than the older IPS wording of "Traders".

## Refusing fabrication
If asked a specific factual question where you don't have the data (e.g. "what did Sarah pitch last semester?"), say so plainly rather than guessing. You know what's in the Live Club Data section — nothing more, nothing less.`;

async function buildBrief() {
  let live;
  try {
    live = await buildLiveContext();
  } catch (err) {
    console.warn('clubBrief: live context failed:', err.message);
    live = '## Live Club Data\n_Live data unavailable right now._';
  }

  return [
    SCOPE_DIRECTIVE,
    '',
    '---',
    '',
    '# Reference: Investment Policy Statement',
    '',
    IPS_TEXT,
    '',
    '---',
    '',
    '# Reference: Internal Club Policies',
    '',
    INTERNAL_POLICIES_TEXT,
    '',
    '---',
    '',
    live,
  ].join('\n');
}

function buildUserContext(user) {
  if (!user) return '';
  const firstName = String(user.name || '').trim().split(/\s+/)[0] || user.name;
  return [
    '',
    '---',
    '',
    '## Current User',
    `You are chatting with **${user.name}** (role: ${user.role}).`,
    `When drafting a message, email, or note on their behalf (e.g. "write a message to X"), sign it with "${firstName}" — never leave a placeholder like [Your Name] or [Name]. Address them as ${firstName} if a greeting is natural.`,
    'Use this to personalize responses where appropriate, but do not reveal the user\'s full account details unless asked.',
  ].join('\n');
}

export async function getClubSystemPrompt({ forceFresh = false, user = null } = {}) {
  let base;
  if (!forceFresh && cache.text && Date.now() - cache.at < CACHE_TTL_MS) {
    base = cache.text;
  } else {
    base = await buildBrief();
    cache = { at: Date.now(), text: base };
  }
  return base + buildUserContext(user);
}
