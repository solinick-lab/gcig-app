// "Breaking news" for the app Dashboard — deliberately rare. This surfaces
// only the handful of genuinely system-shaking stories a portfolio manager
// would want pushed at them: a central-bank shock, a systemic financial
// event, the outbreak of a war, a market-wide crash with a clear catalyst.
// The design target is ONE OR TWO alerts in a week, and most weeks fewer —
// this is a "stop and look up" surface, not a news feed. The terminal's TOP
// / BreakingStrip carry the ordinary flow; this is the tier above.
//
// Three gates keep the volume down:
//   1. The LLM must rate a story genuinely critical AND score it >= a high
//      severity bar. Most days nothing clears it, and "nothing" is the
//      correct, expected answer.
//   2. A rolling 7-day budget caps NEW alerts at three — a story only
//      jumps the spent budget if it's rated a maximal, once-a-year 10.
//   3. Deduplication: an ongoing story (same headline seen in the last 7
//      days) never re-fires, so a week-long war doesn't alert every morning.
//
// A chosen alert persists on the dashboard for a few days so members who
// don't open the app daily still catch it, then clears itself — it's a
// notification, not a permanent banner.
//
// State is in-memory (one LLM call per NY day, shared across all members).
// A server restart resets the budget/history; worst case that lets one
// extra alert through after a redeploy, which is an acceptable trade for
// not standing up a table for a once-a-week banner.

import { getNewsForTicker } from './news.js';
import { llmChat } from './llm.js';

const CANDIDATE_COUNT = 15; // how many recent headlines the model ranks
const RETRY_THROTTLE_MS = 30 * 60 * 1000; // after a failed attempt, wait 30m

const SEVERITY_THRESHOLD = 9; // 1–10; only >= this qualifies as "breaking"
const OVERRIDE_SEVERITY = 10; // a maximal crisis fires even past the budget
const WEEKLY_BUDGET = 3; // at most this many NEW alerts per rolling 7 days
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_TTL_MS = 4 * 24 * 60 * 60 * 1000; // how long a chosen alert shows

// NY calendar day (YYYY-MM-DD). The club and custodian run on New York time,
// so a pre-open headline should count toward that trading day.
function nyDay() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Scan bookkeeping — throttles the LLM to one definitive pass per NY day
// (with a retry window after a transient failure).
let scan = { day: null, computed: false, lastTryAt: 0 };
// The alert currently on the dashboard (or null). `chosenAt` drives the TTL.
let current = null; // { headline, chosenAt, severity, key, day }
// Rolling record of alerts fired, for the weekly budget and dedup.
let history = []; // [{ key, at, severity }]

// Collapse a headline to a comparison key so an ongoing story (re-worded
// across outlets and days) is recognized as the same event and not
// re-alerted. Lowercase, strip punctuation, keep the first several words.
function keyOf(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 8)
    .join(' ');
}

function pruneHistory(now) {
  history = history.filter((h) => now - h.at < HISTORY_WINDOW_MS);
}

function freshCurrent(now) {
  if (!current) return null;
  if (now - current.chosenAt > ALERT_TTL_MS) {
    current = null;
    return null;
  }
  return current;
}

function pickCandidates(articles) {
  return [...(articles || [])]
    .filter((a) => a && a.title && a.url)
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
    .slice(0, CANDIDATE_COUNT);
}

async function classify(candidates) {
  const list = candidates
    .map((a, i) => `${i}. [${a.source || 'wire'}] ${a.title}`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        'You are the risk editor for a student investment fund, deciding whether to PUSH a rare, ' +
        'high-priority alert to every member. From a list of market-wide headlines, identify AT MOST ONE ' +
        'story that is genuinely system-shaking — the kind you would interrupt someone for. ' +
        'Qualifying: a central-bank rate decision or emergency policy shift, a systemic financial event ' +
        '(a bank failure, a credit freeze), the outbreak or major escalation of a war, a sovereign default, ' +
        'a major sanctions regime, or a market-wide crash or spike with a clear catalyst. ' +
        'NOT qualifying: any single-company news or earnings, analyst notes, sector moves, political ' +
        'horse-race coverage, opinion, or "markets drift" days. ' +
        'Calibrate to volume: this alert should fire only ONCE OR TWICE IN A WEEK at most, and most days ' +
        'NOTHING clears it. When in doubt, return nothing — silence is the correct default. ' +
        'Also rate severity 1–10, where 9+ means "a portfolio manager must know this now" and 10 means a ' +
        'generational, once-a-year systemic crisis. Only rate 9+ for stories that truly warrant an alert.\n\n' +
        'Reply with strict JSON only, no prose, no code fences. Shape: ' +
        '{"critical": boolean, "index": number|null, "severity": number, "why": string}. ' +
        'If nothing qualifies: {"critical": false, "index": null, "severity": 0, "why": ""}. ' +
        '"index" is the 0-based position of the chosen headline. "why" is one short sentence (max 18 words).',
    },
    { role: 'user', content: `Headlines:\n${list}` },
  ];

  const raw = await llmChat({
    messages,
    jsonMode: true,
    temperature: 0,
    timeoutMs: 15_000,
    preferQuality: true,
  });
  if (!raw) return { unavailable: true };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unavailable: true };
  }
  if (!parsed || parsed.critical !== true) return { verdict: null };

  const idx = Number(parsed.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) {
    return { verdict: null };
  }
  const severity = Number(parsed.severity);
  const a = candidates[idx];
  return {
    verdict: {
      severity: Number.isFinite(severity) ? severity : 0,
      headline: {
        title: a.title,
        url: a.url,
        source: a.source || null,
        publishedAt: a.publishedAt || null,
        why: String(parsed.why || '').slice(0, 160),
        severity: Number.isFinite(severity) ? severity : null,
      },
    },
  };
}

// Adopt a verdict as the live alert if it clears the severity bar, isn't a
// repeat of a recent story, and fits the weekly budget (or is a maximal
// crisis). Returns true if a new alert was set.
function consider(verdict, day, now) {
  if (!verdict || verdict.severity < SEVERITY_THRESHOLD) return false;
  const key = keyOf(verdict.headline.title);
  // Ongoing story already alerted this week — don't fire again.
  if (history.some((h) => h.key === key)) return false;
  // Budget spent — only a maximal crisis overrides it.
  if (history.length >= WEEKLY_BUDGET && verdict.severity < OVERRIDE_SEVERITY) {
    return false;
  }
  current = { headline: verdict.headline, chosenAt: now, severity: verdict.severity, key, day };
  history.push({ key, at: now, severity: verdict.severity });
  return true;
}

// Returns { headline, day } where headline is the live alert or null.
// Never throws — on any failure it returns whatever alert is still fresh
// (or null) for today.
export async function getDailyCriticalHeadline() {
  const day = nyDay();
  const now = Date.now();
  pruneHistory(now);

  // Already reached a definitive verdict today — just return the live alert.
  if (scan.day === day && scan.computed) {
    const c = freshCurrent(now);
    return { headline: c?.headline || null, day };
  }
  // A recent attempt failed — hold off so a down provider isn't hammered,
  // but still show any alert that's already live.
  if (scan.day === day && scan.lastTryAt && now - scan.lastTryAt < RETRY_THROTTLE_MS) {
    const c = freshCurrent(now);
    return { headline: c?.headline || null, day };
  }
  // New day resets the once-per-day scan gate (history/current persist).
  if (scan.day !== day) scan = { day, computed: false, lastTryAt: 0 };

  try {
    const data = await getNewsForTicker('SPY', '');
    const candidates = pickCandidates(data?.articles);
    if (candidates.length === 0) {
      scan.lastTryAt = now; // transient — allow a retry later today
      const c = freshCurrent(now);
      return { headline: c?.headline || null, day };
    }

    const { unavailable, verdict } = await classify(candidates);
    if (unavailable) {
      scan.lastTryAt = now;
      const c = freshCurrent(now);
      return { headline: c?.headline || null, day };
    }

    // Definitive pass for today. Adopt the verdict if it clears every gate;
    // otherwise the existing (still-fresh) alert stands or we show nothing.
    scan.computed = true;
    scan.lastTryAt = now;
    consider(verdict, day, now);
    const c = freshCurrent(now);
    return { headline: c?.headline || null, day };
  } catch {
    scan.lastTryAt = now;
    const c = freshCurrent(now);
    return { headline: c?.headline || null, day };
  }
}
