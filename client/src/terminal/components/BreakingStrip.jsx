import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// Breaking-news strip — a thin live wire pinned under the command bar.
// Pulls the market-wide headline feed every 30 minutes and rotates through
// the most relevant stories one at a time (a real ticker cadence), pausing
// on hover so a headline you want to click stays put. The whole strip is a
// link to the current story's source outlet.
//
// This is the terminal's "relevant but not critical" news surface; the
// genuinely market-moving one-a-day headline lives on the app Dashboard.

const REFRESH_MS = 30 * 60 * 1000; // pull fresh headlines every 30 min
const ROTATE_MS = 9_000; // advance the visible headline every 9s
const MAX_HEADLINES = 12;

// Source whitelist. Breaking news from anywhere REPUTABLE — a broad set of
// wire services and major newsrooms — but AP is prioritized, Reuters a notch
// below, the other majors after. This is an allow-list on purpose: a source
// that isn't on it is dropped (returns -1), which keeps opinion blogs,
// retail-analysis sites, partisan outlets, and obscure aggregators off a
// board-facing wire. "From anywhere reputable", not "from literally anywhere".
const SOURCE_RANK = [
  [/associated press|\bAP News\b|\bAP\b/i, 100], // AP — top priority
  [/\bAFP\b|agence france-?presse/i, 92],
  [/bloomberg/i, 88],
  [/reuters/i, 82], // Reuters — a notch below AP
  [/wall street journal|\bWSJ\b/i, 74],
  [/new york times|\bNYT\b/i, 72],
  [/the economist/i, 72],
  [/financial times|\bFT\b/i, 72],
  [/washington post/i, 70],
  [/\bNPR\b/i, 70],
  [/\bBBC\b/i, 70],
  [/\bPBS\b/i, 68],
  [/\bCNBC\b/i, 66],
  [/\bAxios\b/i, 66],
  [/\bCNN\b/i, 62],
  [/al jazeera/i, 62],
  [/euronews|deutsche welle|\bDW\b|france ?24/i, 60],
  [/politico/i, 60],
  [/the hill/i, 58],
  [/\bCBS\b|\bABC\b|\bNBC\b|\bPBS\b/i, 58],
  [/the guardian/i, 58],
  [/\bUSA Today\b/i, 56],
  [/los angeles times|\bLA Times\b/i, 56],
  [/\bFortune\b/i, 56],
  [/\bTime\b(?! ?s)/i, 54],
  [/\bNikkei\b|south china morning post|\bSCMP\b/i, 54],
  [/marketwatch/i, 54],
  [/barron'?s/i, 54],
  [/financial post|globe and mail/i, 52],
  [/\bABC News\b|\bCBS News\b|\bNBC News\b/i, 56],
];

// Priority for a source string. -1 = not on the whitelist (dropped);
// otherwise higher = higher priority.
function sourceRank(source) {
  const s = String(source || '');
  if (!s) return -1;
  for (const [re, rank] of SOURCE_RANK) if (re.test(s)) return rank;
  return -1; // not a whitelisted outlet — dropped
}

// AP is prioritized and should dominate the strip — but not to the point of
// crowding every other major out entirely. Cap AP to a strong majority of
// the headlines so it clearly leads (top positions, most slots) while
// Reuters, Bloomberg and the other majors still get a couple of look-ins.
// "Mostly AP", not "only AP".
const AP_CAP = 8;

// AP sits alone at the top of SOURCE_RANK. We cap AP by that rank rather
// than by matching the literal string "AP": the production wire hands us
// the raw outlet name ("Associated Press", "AP News"), so the old
// `/^AP$/` test never fired on the server path and AP silently filled
// every slot — the exact monopoly this cap exists to prevent. It only
// looked fine locally because the demo proxy normalizes the name to "AP".
const AP_RANK = 100;

// Order a set of {title,url,source,publishedAt} by source priority (AP first)
// then newest-first, drop blocked sources, and cap the AP share.
function curate(articles) {
  const ranked = articles
    .filter((a) => a && a.title && a.url)
    .map((a) => ({ a, rank: sourceRank(a.source) }))
    .filter((x) => x.rank >= 0)
    .sort((x, y) =>
      y.rank !== x.rank
        ? y.rank - x.rank
        : new Date(y.a.publishedAt || 0) - new Date(x.a.publishedAt || 0)
    );

  const out = [];
  let apCount = 0;
  for (const { a, rank } of ranked) {
    if (rank === AP_RANK) {
      if (apCount >= AP_CAP) continue; // AP quota spent — let others through
      apCount += 1;
    }
    out.push(a);
    if (out.length >= MAX_HEADLINES) break;
  }
  return out;
}

// Breaking-news wire via Google News RSS (proxied through /gnews — see
// vite.demo.config.js). Pulls a broad business + world feed AND an AP feed,
// so coverage is wide but AP is well-represented and ranked to the top.
// Returns [] when the feed is unreachable (e.g. production without the /gnews
// proxy) so the caller falls back to the curated market feed.
const WIRE_QUERY =
  'when:1d (economy OR markets OR stocks OR "Federal Reserve" OR inflation OR ' +
  '"interest rates" OR tariffs OR recession OR earnings OR Ukraine OR Israel OR ' +
  'Iran OR Russia OR China OR NATO OR sanctions OR "foreign policy" OR election OR "White House")';
const AP_QUERY =
  'site:apnews.com when:2d (economy OR markets OR "Federal Reserve" OR inflation OR ' +
  'tariffs OR earnings OR Ukraine OR Israel OR Iran OR Russia OR China OR NATO OR ' +
  'sanctions OR "foreign policy" OR election OR Congress OR "White House")';
const WIRE_FEEDS = [
  '/gnews/rss/search?q=' + encodeURIComponent(AP_QUERY) + '&hl=en-US&gl=US&ceid=US:en',
  '/gnews/rss/search?q=' + encodeURIComponent(WIRE_QUERY) + '&hl=en-US&gl=US&ceid=US:en',
];

function normalizeSource(raw) {
  const s = String(raw || '');
  if (/associated press|ap news/i.test(s)) return 'AP';
  if (/reuters/i.test(s)) return 'Reuters';
  return s.replace(/\s*News$/i, '').trim() || s;
}

async function fetchFeed(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/xml' } });
    if (!res.ok) return [];
    const xml = await res.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    if (doc.querySelector('parsererror')) return [];
    const rows = [];
    for (const item of doc.querySelectorAll('item')) {
      const url2 = item.querySelector('link')?.textContent?.trim();
      const rawTitle = item.querySelector('title')?.textContent?.trim() || '';
      const srcTag = item.querySelector('source')?.textContent?.trim() || '';
      // Skip Google's synthetic query-echo row.
      if (!url2 || !rawTitle || /google/i.test(srcTag)) continue;
      // Google News titles are "Headline - Source"; drop the trailing source.
      const escaped = srcTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const title =
        (srcTag
          ? rawTitle.replace(new RegExp(`\\s*[-–]\\s*${escaped}\\s*$`, 'i'), '').trim()
          : rawTitle) || rawTitle;
      const publishedAt = item.querySelector('pubDate')?.textContent?.trim() || null;
      rows.push({ title, url: url2, source: normalizeSource(srcTag), publishedAt });
    }
    return rows;
  } catch {
    return [];
  }
}

async function loadWire() {
  // 1. Production: the server fetches the wire for us (no browser CORS). This
  //    is the real path once /api/terminal/breaking-wire is deployed.
  try {
    const { data } = await api.get('/terminal/breaking-wire');
    // The server returns the raw Google News outlet name ("Associated
    // Press", "Reuters News"); fold it to the same short form the demo
    // proxy uses so display and the AP-rank cap stay consistent.
    const arts = (data?.articles || [])
      .filter((a) => a && a.title && a.url)
      .map((a) => ({ ...a, source: normalizeSource(a.source) }));
    if (arts.length) return curate(arts);
  } catch {
    /* older server without the endpoint — fall through to the demo proxy */
  }

  // 2. Demo: the local /gnews proxy (see vite.demo.config.js). Lets the demo
  //    show the real AP wire before the server endpoint is deployed.
  const all = (await Promise.all(WIRE_FEEDS.map(fetchFeed))).flat();
  if (!all.length) return [];
  const seen = new Set();
  const unique = [];
  for (const a of all) {
    const key = a.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }
  return curate(unique);
}

export default function BreakingStrip() {
  const [items, setItems] = useState([]);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(false);

  // Fetch + refresh the headline pool. Prefer the AP-first wire; fall back
  // to the curated market feed when the wire isn't reachable.
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const wire = await loadWire();
      if (cancelled) return;
      if (wire.length) {
        setItems(wire);
        setIdx((i) => i % wire.length);
        return;
      }
      try {
        const { data } = await api.get('/terminal/top-news');
        if (cancelled) return;
        const list = curate(data?.articles || []);
        setItems(list);
        setIdx((i) => (list.length ? i % list.length : 0));
      } catch {
        /* leave the last good headlines up; a blip shouldn't blank the wire */
      }
    };
    pull();
    const id = setInterval(pull, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Auto-rotate through the pool unless the user is hovering (reading/aiming).
  useEffect(() => {
    if (paused || items.length <= 1) return;
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % items.length);
    }, ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, items.length]);

  if (hidden || items.length === 0) return null;

  const current = items[Math.min(idx, items.length - 1)];
  if (!current) return null;

  return (
    <div
      className="term-breaking"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="term-breaking-tag">
        <span className="dot" /> BREAKING
      </span>

      <a
        className="term-breaking-headline"
        href={current.url}
        target="_blank"
        rel="noopener noreferrer"
        title={current.title}
      >
        {current.source ? <span className="src">{current.source}</span> : null}
        <span className="hl">{current.title}</span>
      </a>

      <div className="term-breaking-nav">
        <button
          onClick={() => setIdx((i) => (i - 1 + items.length) % items.length)}
          title="Previous headline"
          aria-label="Previous headline"
        >
          ‹
        </button>
        <span className="count">
          {Math.min(idx, items.length - 1) + 1}/{items.length}
        </span>
        <button
          onClick={() => setIdx((i) => (i + 1) % items.length)}
          title="Next headline"
          aria-label="Next headline"
        >
          ›
        </button>
        <button
          className="close"
          onClick={() => setHidden(true)}
          title="Hide breaking bar"
          aria-label="Hide breaking bar"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
