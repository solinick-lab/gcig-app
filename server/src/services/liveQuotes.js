// The terminal's quote spine. Every quote-bearing panel (DES, Peers,
// MOVR, WEI) that wants a fresh price goes through here, never straight
// to Finnhub — that indirection is the whole point. Finnhub free is
// ~60 req/min with no batch endpoint, shared with the long-cached
// fundamentals/news/earnings pulls; if each panel × each client × each
// poll cycle hit /quote directly the budget would evaporate. A
// per-ticker short-TTL cache plus in-flight coalescing collapses all
// that demand to at most one upstream call per ticker per TTL, so the
// rate cost is (unique on-screen tickers ÷ TTL) regardless of how many
// panels or clients are watching. Same never-throws / honest-`null`
// contract as the rest of the terminal services.
//
// The /quote fetch itself is the proven path behind routes/holdings.js
// `fetchFinnhub` and services/marketData.js `getPeerSnapshot`: same
// endpoint, same `FINNHUB_API_KEY` env, same `c=0`-means-unknown rule,
// same ~8s abort. defaultQuoteFetch mirrors that one call rather than
// importing a wider profile+metric fetcher — the divergence to avoid
// is a second, differently-keyed Finnhub client, not a one-line URL.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const DEFAULT_TIMEOUT_MS = 8_000; // matches marketData.js finnhubFetch

// The single tunable that bounds Finnhub usage. Worst realistic
// terminal load is DES(1) + Peers(~7) + MOVR(~9) open at once ≈ ~15
// unique tickers (overlap shrinks it). At a 20s TTL that is ~45
// upstream calls/min worst case, leaving headroom under the ~60/min
// free cap for the long-cached fundamentals/news/earnings traffic.
// Raising this trades a few seconds of price latency for more budget —
// the documented lever if real usage ever proves tight.
export const QUOTE_TTL_MS = 20_000;

// ticker → { at, value } where value is { last, changePct, prevClose }
// or null (an honest miss is cached too, so a dead symbol is not
// hammered every poll). `at` is stamped from the injected clock so TTL
// expiry is testable without real sleeps.
const cache = new Map();

// ticker → in-flight Promise<value>. While a cold ticker is being
// fetched, concurrent callers await this same promise instead of
// firing their own request — a burst of panel mounts for one cold
// ticker costs exactly one upstream call.
const inflight = new Map();

export function _resetLiveQuotes() {
  cache.clear();
  inflight.clear();
}

// The real /quote call, reusing routes/holdings.js fetchFinnhub's
// mechanism verbatim: no key → no data (null), c=0 → unknown symbol
// (null), ~8s abort so a stalled upstream can't wedge a poll cycle.
// Returns the raw Finnhub object ({c,d,dp,pc,...}) or null; never the
// caller's job to interpret HTTP here.
async function defaultQuoteFetch(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(ticker)}` +
        `&token=${encodeURIComponent(key)}`,
      { signal: controller.signal }
    );
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Finnhub /quote → our compact shape. Finnhub stamps c=0 for an
// unknown symbol (the same tell fetchFinnhub / getPeerSnapshot key
// off), so a falsy `c` with no real print is an honest miss → null,
// never a fabricated zero. dp is already a percent (1.23 == +1.23%).
function mapQuote(raw) {
  if (!raw || !raw.c) return null;
  return {
    last: raw.c,
    changePct: raw.dp ?? null,
    prevClose: raw.pc ?? null,
  };
}

// Resolve one ticker through the cache + coalescer. Fresh cache hit →
// return it. Otherwise reuse an in-flight fetch if one exists, else
// start one, register it so concurrent callers coalesce onto it, and
// cache the result (including a null miss) under the injected clock.
// Never throws — a rejecting fetch resolves the ticker to null.
async function resolveTicker(sym, quoteFetch, now) {
  const hit = cache.get(sym);
  if (hit && now() - hit.at < QUOTE_TTL_MS) return hit.value;

  const pending = inflight.get(sym);
  if (pending) return pending;

  const p = (async () => {
    let value = null;
    try {
      value = mapQuote(await quoteFetch(sym));
    } catch (err) {
      console.warn(`liveQuotes(${sym}) failed:`, err.message);
      value = null;
    }
    cache.set(sym, { at: now(), value });
    return value;
  })();

  inflight.set(sym, p);
  try {
    return await p;
  } finally {
    inflight.delete(sym);
  }
}

// getLiveQuotes(tickers, deps) -> { [TICKER]: {last,changePct,prevClose}
// | null }. Callers pass only their on-screen set; this service does
// not cap (the route does). Upper-cases + de-dupes, ignores falsy /
// non-string entries, and never throws — junk or a non-array input
// degrades to {} rather than propagating.
//
// deps.quoteFetch(ticker) -> raw Finnhub quote object (default: the
// real /quote fetch above) makes the service network-free under test.
// deps.now() -> ms (default Date.now) drives all cache time math so
// TTL expiry is exercised with a controllable clock, no real sleeps.
export async function getLiveQuotes(tickers, deps = {}) {
  if (!Array.isArray(tickers)) return {};
  const quoteFetch = deps.quoteFetch || defaultQuoteFetch;
  const now = deps.now || Date.now;

  const list = Array.from(
    new Set(
      tickers
        .filter((t) => typeof t === 'string' && t.trim())
        .map((t) => t.trim().toUpperCase())
    )
  );
  if (list.length === 0) return {};

  const out = {};
  // Per-ticker resolution runs in parallel; each path is independently
  // never-throwing, so allSettled is belt-and-braces — a stray
  // rejection still can't sink a sibling ticker or the whole call.
  const settled = await Promise.allSettled(
    list.map((sym) => resolveTicker(sym, quoteFetch, now))
  );
  list.forEach((sym, i) => {
    const s = settled[i];
    out[sym] = s.status === 'fulfilled' ? s.value : null;
  });
  return out;
}
