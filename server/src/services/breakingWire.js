// Breaking-news wire for the terminal strip. Pulls a broad business + world
// feed AND an AP-specific feed from Google News RSS (public, no key; it
// carries AP, Reuters, Bloomberg, the major papers, etc.), server-side so
// there's no browser CORS problem. Returns a raw, de-duped list of
// { title, url, source, publishedAt }; the client ranks/curates it (AP
// prioritized, opinion/retail sources dropped — see BreakingStrip.jsx).
//
// Cached ~10 min: the strip refreshes every 30 min and this is shared across
// all terminal users, so we don't hammer Google.

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_ITEMS = 40;

// Targeted business + geopolitics terms (deliberately NOT generic words like
// "world"/"business" that pull in World Cup and sports noise), plus an
// AP-specific feed so AP is well-represented for the client's AP-first rank.
const WIRE_QUERY =
  'when:1d (economy OR markets OR stocks OR "Federal Reserve" OR inflation OR ' +
  '"interest rates" OR tariffs OR recession OR earnings OR Ukraine OR Israel OR ' +
  'Iran OR Russia OR China OR NATO OR sanctions OR "foreign policy" OR election OR "White House")';
// AP feed first: fetched before the broad feed (and sequentially) so if
// Google throttles a back-to-back request, it's the broad feed that drops,
// not AP — AP is the one we most want to land for the client's AP-first rank.
// AP feed, topic-filtered to business + geopolitics (a bare site: query
// returns general AP news — obituaries, fires, sport — which isn't what this
// wire is for). Fetched first so a throttle drops the broad feed, not AP.
const AP_QUERY =
  'site:apnews.com when:2d (economy OR markets OR "Federal Reserve" OR inflation OR ' +
  'tariffs OR earnings OR Ukraine OR Israel OR Iran OR Russia OR China OR NATO OR ' +
  'sanctions OR "foreign policy" OR election OR Congress OR "White House")';
const FEEDS = [
  'https://news.google.com/rss/search?q=' +
    encodeURIComponent(AP_QUERY) +
    '&hl=en-US&gl=US&ceid=US:en',
  'https://news.google.com/rss/search?q=' +
    encodeURIComponent(WIRE_QUERY) +
    '&hl=en-US&gl=US&ceid=US:en',
];

// AP is prioritized but must not crowd out diversity: keep at most this many
// AP items in the merged pool so the broad feed's other majors survive the
// MAX_ITEMS cap. (The client further caps AP in what it actually shows.)
const MAX_AP_IN_POOL = 15;

let cache = { at: 0, data: null };

// Minimal HTML-entity decode for the handful that show up in RSS titles.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return _;
      }
    });
}

function tagText(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

// Google News titles are "Headline - Source"; drop the trailing source.
function stripSourceSuffix(title, source) {
  if (!source) return title;
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`\\s*[-–]\\s*${escaped}\\s*$`, 'i'), '').trim() || title;
}

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const out = [];
    const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    for (const block of items) {
      const url2 = tagText(block, 'link');
      const rawTitle = tagText(block, 'title');
      const source = tagText(block, 'source');
      if (!url2 || !rawTitle || /google/i.test(source)) continue;
      out.push({
        title: stripSourceSuffix(rawTitle, source),
        url: url2,
        source,
        publishedAt: tagText(block, 'pubDate') || null,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Returns { articles: [...], fetchedAt } — raw + de-duped, newest-ranking left
// to the client. Never throws; returns an empty list on total failure.
export async function getBreakingWire() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  // Sequential (AP first) rather than parallel — two simultaneous hits to
  // Google News RSS is what triggers the throttle that was intermittently
  // emptying the AP feed.
  const all = [];
  for (const url of FEEDS) {
    all.push(...(await fetchFeed(url)));
  }
  // Split AP from the rest so AP (fetched first, hundreds of items) can't
  // swallow the whole MAX_ITEMS budget and starve the broad feed.
  const seen = new Set();
  const ap = [];
  const other = [];
  for (const a of all) {
    const key = a.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
    if (seen.has(key)) continue;
    seen.add(key);
    (/associated press|ap news/i.test(a.source) ? ap : other).push(a);
  }
  const articles = [...ap.slice(0, MAX_AP_IN_POOL), ...other].slice(0, MAX_ITEMS);

  const data = { articles, fetchedAt: new Date().toISOString() };
  // Only cache a non-empty result so a transient Google blip doesn't pin an
  // empty wire for 10 minutes.
  if (articles.length > 0) cache = { at: Date.now(), data };
  return data;
}
