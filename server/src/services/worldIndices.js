// WEI data. Yahoo's quote *and* chart endpoints both rate-limit/403
// from Render's datacenter IP (same class of block as the GSAM PDF
// issue), so the World Indices panel went blank no matter how we
// called Yahoo. Stooq's keyless light-CSV endpoint works fine from
// datacenter IPs and — with the `p` field — carries last *and* prior
// close in a single batched request, enough to derive the day move.
// The handful of indices Stooq doesn't expose for free fall back to
// Finnhub (already our quote/news provider) via a liquid US-listed
// proxy ETF; the ETF's %-move tracks the index closely even though its
// absolute level differs, so those rows are flagged `approx`.

const STOOQ_URL = 'https://stooq.com/q/l/';
const FINNHUB_URL = 'https://finnhub.io/api/v1/quote';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// `stooq` is the light-CSV symbol (verified against the live endpoint;
// null where Stooq has no free feed). `proxy` is the Finnhub ETF stand-in
// used only when Stooq misses. Array order is render order.
export const WORLD_INDICES = [
  { name: 'S&P 500', region: 'Americas', stooq: '^spx', proxy: 'SPY' },
  { name: 'Dow Jones Industrial', region: 'Americas', stooq: '^dji', proxy: 'DIA' },
  { name: 'Nasdaq Composite', region: 'Americas', stooq: '^ndq', proxy: 'ONEQ' },
  { name: 'Russell 2000', region: 'Americas', stooq: null, proxy: 'IWM' },
  { name: 'S&P/TSX Composite', region: 'Americas', stooq: '^tsx', proxy: 'EWC' },
  { name: 'Bovespa', region: 'Americas', stooq: '^bvp', proxy: 'EWZ' },
  { name: 'FTSE 100', region: 'EMEA', stooq: '^ukx', proxy: 'EWU' },
  { name: 'DAX', region: 'EMEA', stooq: '^dax', proxy: 'EWG' },
  { name: 'CAC 40', region: 'EMEA', stooq: '^cac', proxy: 'EWQ' },
  { name: 'Euro Stoxx 50', region: 'EMEA', stooq: null, proxy: 'FEZ' },
  { name: 'IBEX 35', region: 'EMEA', stooq: '^ibex', proxy: 'EWP' },
  { name: 'Nikkei 225', region: 'Asia-Pacific', stooq: '^nkx', proxy: 'EWJ' },
  { name: 'Hang Seng', region: 'Asia-Pacific', stooq: '^hsi', proxy: 'EWH' },
  { name: 'Shanghai Composite', region: 'Asia-Pacific', stooq: '^shc', proxy: 'FXI' },
  { name: 'S&P/ASX 200', region: 'Asia-Pacific', stooq: null, proxy: 'EWA' },
  { name: 'Nifty 50', region: 'Asia-Pacific', stooq: null, proxy: 'INDA' },
  { name: 'KOSPI', region: 'Asia-Pacific', stooq: '^kospi', proxy: 'EWY' },
  { name: 'CBOE Volatility', region: 'Volatility', stooq: null, proxy: 'VIXY' },
];

export const REGION_ORDER = ['Americas', 'EMEA', 'Asia-Pacific', 'Volatility'];

const CACHE_TTL_MS = 60_000;
let cache = null; // { at, rows }

// CSV header: Symbol,Date,Time,Open,High,Low,Close,Volume,Prev
// Unknown symbols come back as a row of "N/D" — Number() makes those
// NaN, which we drop so they cleanly fall through to the proxy.
function parseStooqCsv(text) {
  const out = new Map();
  const lines = String(text).trim().split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 9) continue;
    const close = Number(c[6]);
    const prev = Number(c[8]);
    if (!Number.isFinite(close)) continue;
    out.set(c[0].toUpperCase(), {
      last: close,
      prev: Number.isFinite(prev) ? prev : null,
    });
  }
  return out;
}

async function fetchStooq(symbols) {
  if (symbols.length === 0) return new Map();
  const url = `${STOOQ_URL}?s=${symbols.join('+')}&f=sd2t2ohlcvp&h&e=csv`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' },
    });
    if (!r.ok) return new Map();
    return parseStooqCsv(await r.text());
  } catch {
    return new Map();
  }
}

async function fetchFinnhubProxy(symbol) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(
      `${FINNHUB_URL}?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    // Finnhub: c=current, d=change, dp=%change, pc=prev close.
    // c===0 is Finnhub's "no data" sentinel for unknown symbols.
    if (!j || j.c == null || j.c === 0) return null;
    return { last: j.c, change: j.d ?? null, changePercent: j.dp ?? null };
  } catch {
    return null;
  }
}

// One row per index, Stooq first then the Finnhub proxy. A total miss
// still returns a stub so the panel renders "—" rather than failing.
export async function getWorldIndices() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;

  const stooqSyms = WORLD_INDICES.filter((i) => i.stooq).map((i) =>
    i.stooq.toUpperCase()
  );
  const stooq = await fetchStooq(stooqSyms);

  const rows = await Promise.all(
    WORLD_INDICES.map(async (idx) => {
      const base = { name: idx.name, region: idx.region };

      if (idx.stooq) {
        const hit = stooq.get(idx.stooq.toUpperCase());
        if (hit && hit.last != null) {
          const change = hit.prev != null ? hit.last - hit.prev : null;
          return {
            ...base,
            symbol: idx.stooq.toUpperCase(),
            last: hit.last,
            change,
            changePercent:
              change != null && hit.prev ? (change / hit.prev) * 100 : null,
            source: 'stooq',
            approx: false,
          };
        }
      }

      if (idx.proxy) {
        const p = await fetchFinnhubProxy(idx.proxy);
        if (p && p.last != null) {
          return {
            ...base,
            symbol: idx.proxy,
            last: p.last,
            change: p.change,
            changePercent: p.changePercent,
            source: `finnhub:${idx.proxy}`,
            approx: true,
          };
        }
      }

      return {
        ...base,
        symbol: idx.stooq ? idx.stooq.toUpperCase() : idx.proxy || '',
        last: null,
        change: null,
        changePercent: null,
        source: null,
        approx: false,
      };
    })
  );

  cache = { at: Date.now(), rows };
  return rows;
}
