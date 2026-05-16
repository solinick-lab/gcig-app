// SEC EDGAR filings feed for held tickers. Free, no API key — SEC's
// only requirement is a meaningful User-Agent header identifying who
// you are. Two pieces of plumbing:
//
//   1. company_tickers.json maps every public ticker → CIK number.
//      ~1MB JSON, refreshed once a day.
//   2. data.sec.gov/submissions/CIK{XXXXXXXXXX}.json gives recent
//      filings for a CIK — accession numbers, form types (8-K,
//      10-Q, 10-K, etc.), filing dates, primary document filenames.
//
// Filings are infrequent so a 6-hour per-ticker cache is plenty.
// ETFs (VOO, QQQ, etc.) appear in the tickers JSON with their fund
// CIK — they file too, just less interesting (NQ-related schedules).
// We don't filter form types here — the UI can decide what to show.

const EDGAR_BASE = 'https://www.sec.gov';
const SUBMISSIONS_BASE = 'https://data.sec.gov';
const TICKERS_URL = `${EDGAR_BASE}/files/company_tickers.json`;

// SEC requires a User-Agent identifying the app + a contact. They've
// publicly threatened to block requests without one and they enforce
// it (10 req/sec rate limit per host).
const UA = 'Griffin Fund (Grace Church School) thegriffinfund.org';
// Single source of truth: any SEC fetch (incl. the proxyStatement doc
// fetch) must send this declarative UA. A browser-impersonating UA gets
// blocked from datacenter IPs — that was the MGMT "no DEF 14A" prod bug.
export { UA as SEC_UA };

const TICKERS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FILINGS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

let tickersCache = { at: 0, map: null };
const filingsCache = new Map(); // upperTicker → { at, data }

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`SEC ${res.status} ${res.statusText} for ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getTickerMap() {
  if (tickersCache.map && Date.now() - tickersCache.at < TICKERS_TTL_MS) {
    return tickersCache.map;
  }
  try {
    const data = await fetchJson(TICKERS_URL);
    const map = new Map();
    for (const k of Object.keys(data)) {
      const row = data[k];
      if (!row || !row.ticker || row.cik_str == null) continue;
      // CIKs in the submissions endpoint are zero-padded to 10 digits.
      const cik = String(row.cik_str).padStart(10, '0');
      map.set(String(row.ticker).toUpperCase(), {
        cik,
        cikInt: Number(row.cik_str),
        name: row.title || row.ticker,
      });
    }
    tickersCache = { at: Date.now(), map };
    return map;
  } catch (err) {
    console.warn('SEC ticker map fetch failed:', err.message);
    // If we already have a stale map, keep using it rather than giving up.
    return tickersCache.map || null;
  }
}

export async function getCikForTicker(ticker) {
  const map = await getTickerMap();
  if (!map) return null;
  return map.get(String(ticker).toUpperCase()) || null;
}

// Fetch the most recent filings for a ticker. Returns up to `limit`
// rows ordered newest-first, each shaped { form, filingDate,
// description, accessionNumber, url } where `url` is the canonical
// EDGAR document link the UI can deep-link to.
export async function getRecentFilings(ticker, { limit = 10 } = {}) {
  const upper = String(ticker || '').toUpperCase();
  if (!upper) return [];

  // The cache key includes the effective cap so a limit-25 warm (e.g.
  // INSDR's SEC fallback) can't satisfy — or poison — a limit-150 read
  // (proxyStatement's DEF 14A search). Each caller's cap gets its own
  // entry; they never collide.
  const cap = Math.max(25, limit);
  const cacheKey = `${upper}:${cap}`;

  const cached = filingsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < FILINGS_TTL_MS) {
    return cached.data.slice(0, limit);
  }

  const info = await getCikForTicker(upper);
  if (!info) {
    // Cache the negative result so we don't keep retrying the lookup
    // for unknown tickers (e.g. cash labels, illiquid foreign issues).
    filingsCache.set(cacheKey, { at: Date.now(), data: [] });
    return [];
  }

  const url = `${SUBMISSIONS_BASE}/submissions/CIK${info.cik}.json`;
  let filings = [];
  try {
    const data = await fetchJson(url);
    const r = data?.filings?.recent;
    if (r && Array.isArray(r.accessionNumber)) {
      // Store enough to satisfy the caller's limit (default 25). Active
      // large-caps push annual filings like DEF 14A well past the first 25
      // rows behind constant 8-Ks/Form 4s, so MGMT needs a deeper window.
      const storedCap = Math.min(r.accessionNumber.length, cap);
      for (let i = 0; i < storedCap; i++) {
        const accession = r.accessionNumber[i];
        if (!accession) continue;
        const accessionNoDashes = accession.replace(/-/g, '');
        const form = r.form[i] || '';
        const filingDate = r.filingDate[i] || '';
        const primaryDocument = r.primaryDocument[i] || '';
        const description =
          r.primaryDocDescription[i] || form || 'Filing';
        // Document URL pattern:
        //   /Archives/edgar/data/{CIK_int}/{ACCESSION_NO_DASHES}/{primaryDocument}
        const docUrl = primaryDocument
          ? `${EDGAR_BASE}/Archives/edgar/data/${info.cikInt}/${accessionNoDashes}/${primaryDocument}`
          : `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${info.cikInt}`;
        filings.push({
          accessionNumber: accession,
          form,
          filingDate,
          description,
          url: docUrl,
        });
      }
    }
  } catch (err) {
    console.warn(`SEC filings(${upper}) failed:`, err.message);
  }

  filingsCache.set(cacheKey, { at: Date.now(), data: filings });
  return filings.slice(0, limit);
}

// Batch helper for the dashboard / AI brief. Each ticker has its own
// 6h cache so this is cheap once warm.
export async function getRecentFilingsForTickers(tickers, opts = {}) {
  const list = Array.from(
    new Set((tickers || []).filter(Boolean).map((t) => String(t).toUpperCase()))
  );
  const rows = await Promise.all(list.map((t) => getRecentFilings(t, opts)));
  const out = {};
  list.forEach((t, i) => {
    out[t] = rows[i] || [];
  });
  return out;
}
