// LLM-powered summaries of news content. Uses the shared llm client, which
// tries local Ollama first and falls back to OpenAI so these keep working
// when the home-machine tunnel goes down.
//
// Entry points:
//
//   summarizeArticle(url, plainText)
//     → 2-3 sentence TL;DR of a single article. Cached in ArticleRanking.summary
//       so a URL is summarized at most once.
//
//   summarizeTickerNews(ticker, articles)
//     → 2-3 sentence paragraph synthesizing the last batch of headlines for
//       a ticker. NOT persisted per-ticker — newsapi itself only gives us a
//       fresh set on cache miss, so we cache this in memory tied to the
//       article set we were given.
//
// Both fail open — if every provider fails or returns garbage we return null
// and callers render as if summaries aren't available.
import prisma from '../db.js';
import { llmChat } from './llm.js';

async function callChat(systemPrompt, userContent, { temperature = 0.2 } = {}) {
  const content = await llmChat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature,
  });
  return typeof content === 'string' ? content.trim() : null;
}

// ── Per-article summaries ─────────────────────────────────────────────

const ARTICLE_SYSTEM_PROMPT = `You are summarizing a news article for members of a student-run investment club. Write 2-3 short sentences (max 60 words total) capturing what happened, why it matters for the company, and any concrete numbers mentioned. Plain prose — no headers, no bullet points, no hedging language like "reportedly" or "appears to". If the text is paywalled or clearly incomplete, return exactly: INSUFFICIENT`;

// Pull an already-saved summary for this URL, if any.
async function loadPersistedSummary(url) {
  try {
    const row = await prisma.articleRanking.findUnique({
      where: { url },
      select: { summary: true },
    });
    return row?.summary || null;
  } catch {
    return null;
  }
}

async function persistSummary(url, summary) {
  try {
    // Upsert so summaries can attach to rows that may not yet have a
    // ranking (e.g. articles fetched but never ranked).
    await prisma.articleRanking.upsert({
      where: { url },
      update: { summary },
      create: { url, summary },
    });
  } catch (err) {
    console.warn('articleSummarizer: persistSummary failed:', err.message);
  }
}

export async function summarizeArticle(url, plainText) {
  if (!url || typeof plainText !== 'string' || plainText.length < 200) return null;
  // Don't re-summarize a URL we've already handled.
  const cached = await loadPersistedSummary(url);
  if (cached) return cached;

  // Keep input bounded; long articles don't need the full body for a
  // tight TL;DR and they eat tokens.
  const body = plainText.slice(0, 6000);
  const out = await callChat(
    ARTICLE_SYSTEM_PROMPT,
    `Article body:\n\n${body}`
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;

  // Drop any stray wrappers the model might add (quotes, "Summary:" prefix).
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();

  if (cleaned.length < 20) return null;

  // Fire-and-forget save; caller doesn't wait for the write.
  persistSummary(url, cleaned).catch(() => {});
  return cleaned;
}

// ── Per-ticker news synthesis ─────────────────────────────────────────

const TICKER_SYSTEM_PROMPT = `You are synthesizing recent news coverage for a stock for members of a student-run investment club. You will be given a list of article headlines with one-line descriptions. Write 2-3 short sentences (max 70 words total) describing the overall narrative: what are investors actually paying attention to right now, what's the mood, and are there any standout items. Plain prose — no bullet points, no meta-commentary, no mention of the article list format. If the batch is too thin to have a narrative (fewer than 3 distinct topics), return exactly: INSUFFICIENT`;

const tickerSummaryCache = new Map();
const TICKER_SUMMARY_TTL_MS = 30 * 60 * 1000;

function tickerCacheKey(ticker, articles) {
  // Cache keyed by the URL set — if the same batch comes back, we reuse.
  const urls = articles
    .map((a) => a.url)
    .filter(Boolean)
    .sort()
    .join('|');
  return `${ticker}::${urls}`;
}

// ── Voting session recaps ─────────────────────────────────────────────

const VOTE_SYSTEM_PROMPT = `You are summarizing the outcome of a closed voting session for a student-run investment club. Write 2-3 short sentences (max 70 words total) capturing:
  - The final decision and weighted tally (e.g. "Club voted Buy 4-2").
  - Who supported vs. opposed, noting if leadership (Presidents/CIO) and the general body aligned.
  - If action = Buy, the proposed allocation range / average.
  - Any recurring theme in the notes members left (valuation, timing, thesis concerns, etc.).

Plain prose — no bullet points, no headers, no meta-commentary. If ballots are sparse (fewer than 3), return exactly: INSUFFICIENT`;

const SELL_VOTE_SYSTEM_PROMPT = `You are summarizing the outcome of a closed vote on whether the club should EXIT an existing holding. The only choices were Sell (exit the position) or Hold (keep it). Write 2-3 short sentences (max 70 words total) in the voice of an analyst's sell-decision note:
  - The final call and weighted tally (e.g. "Club voted Sell 4-2 to exit AAPL").
  - Whether leadership (Presidents/CIO) and the general body aligned.
  - Any recurring theme in the notes members left (valuation, thesis broke, better use of capital, risk, etc.).

There is no dollar amount on a sell vote — do not mention an allocation. Plain prose — no bullet points, no headers, no meta-commentary. If ballots are sparse (fewer than 3), return exactly: INSUFFICIENT`;

export async function summarizeVoteSession(session) {
  if (!session?.ballots?.length || session.ballots.length < 3) return null;
  const payload = {
    ticker: session.ticker,
    title: session.title,
    finalDecision: session.tally?.finalDecision,
    weightedTally: session.tally?.weights,
    generalBody: session.tally?.memberCounts,
    leadership: (session.tally?.leadershipVotes || []).map((v) => ({
      name: v.name,
      role: v.role,
      action: v.action,
    })),
    ballots: session.ballots.map((b) => ({
      name: b.user?.name,
      role: b.user?.role,
      action: b.action,
      amount: b.investmentAmount,
      note: b.note,
    })),
    buyStats: session.tally?.buyAmountStats,
  };
  const out = await callChat(
    session.kind === 'sell' ? SELL_VOTE_SYSTEM_PROMPT : VOTE_SYSTEM_PROMPT,
    `Session:\n${JSON.stringify(payload, null, 2)}`
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  return cleaned.length >= 30 ? cleaned : null;
}

// ── Dashboard week-in-review ──────────────────────────────────────────

const WIR_SYSTEM_PROMPT = `You are writing a one-paragraph weekly briefing for members of a student-run investment club. The pitch, vote, and portfolio fields cover the last 7 days. News in "topNews" is the most material coverage we have for the club's holdings — it may be from this week or somewhat older.

STRICT RULES:
1. Only reference tickers that appear in the input payload — specifically in "heldTickers", "newPitches.ticker", "upcomingPitches.ticker", "openVotes.ticker", "closedVotes.ticker", or "topNews.ticker". NEVER mention any other company or ticker by name.
2. Only cite news items that are present in "topNews". If "topNews" is empty, do NOT mention news at all — don't invent headlines.
3. "topNews" is sorted by materiality, most-material first. Each entry has a "score" 0-10; higher = more important. Prioritize stories near the top of the list. If a story's score is below 6 it's at best a minor mention — give it at most half a clause, or skip it entirely. Don't describe low-score items as "big" or "major".
4. You do NOT know when each news item was published. Frame news neutrally ("recent coverage on X", "news about Y"). NEVER claim a news item happened "this week" unless it clearly did from context.
5. The club does NOT hold every company. If a ticker isn't in "heldTickers", do not describe any event as affecting "our position" in it.
6. Prefer concrete numbers from the input (pitch counts, vote tallies, portfolio % change) over vague language.
7. Write ONE paragraph, max 90 words, plain prose, no bullets, no headers.

If the input is nearly empty (no pitches, no votes, no portfolio move, no news), return exactly: INSUFFICIENT`;

export async function generateWeekInReview(payload) {
  const out = await callChat(
    WIR_SYSTEM_PROMPT,
    JSON.stringify(payload, null, 2)
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  return cleaned.length >= 40 ? cleaned : null;
}

// ── Dashboard day-in-review ──────────────────────────────────────────
// Same structured payload as WIR but narrower: pitches/votes/portfolio
// cover roughly the last 24 hours. Generated once per day at / after
// 4pm ET so the paragraph represents the day's market close.

const DIR_SYSTEM_PROMPT = `You are writing a one-paragraph daily briefing for members of a student-run investment club, stamped "as of 4:00 PM ET market close". The pitch, vote, and portfolio fields in the payload cover roughly the last 24 hours. News in "topNews" is the most material recent coverage for the club's holdings — it may be from today or somewhat older. "recentFilings" is SEC filings on held tickers from the past ~3 days; these ARE dated and you can refer to them confidently.

STRICT RULES:
1. Only reference tickers that appear in the input payload — specifically in "heldTickers", "newPitches.ticker", "upcomingPitches.ticker", "openVotes.ticker", "closedVotes.ticker", "topNews.ticker", or "recentFilings.ticker". NEVER mention any other company or ticker by name.
2. Only cite news items that are present in "topNews". If "topNews" is empty, do NOT mention news at all — don't invent headlines.
3. "topNews" is sorted by materiality, most-material first. Each entry has a "score" 0-10; higher = more important. Prioritize stories near the top of the list. If a story's score is below 6 it's at best a minor mention — give it at most half a clause, or skip it entirely. Don't describe low-score items as "big" or "major".
4. You do NOT know when each news item was published. Frame news neutrally ("recent coverage on X", "news about Y"). NEVER claim a news item happened "today" unless it clearly did from context.
5. SEC filings in "recentFilings" ARE dated (filingDate). When mentioning one, name the form type (8-K, 10-Q, 10-K) and the date, e.g. "NOC filed an 8-K on Apr 21". Don't speculate on what's in the filing — only that it was filed.
6. The club does NOT hold every company. If a ticker isn't in "heldTickers", do not describe any event as affecting "our position" in it.
7. Prefer concrete numbers from the input (pitch counts, vote tallies, portfolio $ and % change) over vague language.
8. Frame portfolio moves as today's close — e.g. "the portfolio closed up $X (Y%) at $Z" rather than "over the week".
9. Write ONE paragraph, max 80 words, plain prose, no bullets, no headers.

If the day was genuinely quiet (no pitches, no votes, trivial portfolio move, no news, no filings), return exactly: INSUFFICIENT`;

export async function generateDayInReview(payload) {
  const out = await callChat(
    DIR_SYSTEM_PROMPT,
    JSON.stringify(payload, null, 2)
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  return cleaned.length >= 40 ? cleaned : null;
}

export async function summarizeTickerNews(ticker, articles) {
  if (!Array.isArray(articles) || articles.length < 3) return null;
  const key = tickerCacheKey(ticker, articles);
  const cached = tickerSummaryCache.get(key);
  if (cached && Date.now() - cached.at < TICKER_SUMMARY_TTL_MS) {
    return cached.summary;
  }

  const bullets = articles
    .slice(0, 12)
    .map(
      (a, i) =>
        `${i + 1}. ${a.title}${a.description ? ' — ' + a.description.slice(0, 180) : ''}`
    )
    .join('\n');

  const out = await callChat(
    TICKER_SYSTEM_PROMPT,
    `Ticker: ${ticker}\n\nArticles:\n${bullets}`
  );
  if (!out || out.trim() === 'INSUFFICIENT') return null;
  const cleaned = out
    .replace(/^["'“”]\s*|\s*["'“”]$/g, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
  if (cleaned.length < 30) return null;
  tickerSummaryCache.set(key, { at: Date.now(), summary: cleaned });
  return cleaned;
}
