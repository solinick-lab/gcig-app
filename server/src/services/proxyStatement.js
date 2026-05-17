// MGMT spine. Retrieves a company's latest DEF 14A and returns the RAW
// HTML — structure-aware parsing happens in governanceParsers.js, which
// needs the real <table> structure (flattening it destroyed the Summary
// Compensation Table and board roster, which is why MGMT was empty for
// large-caps). Best-effort, never throws (same contract as
// services/worldIndices.js): a missing/failed proxy yields an empty stub.
import { getRecentFilings, SEC_UA } from './secFilings.js';

// SEC hands back the XSL viewer URL (.../xslF…/doc.htm → HTML wrapper).
// The raw primary document sits at the same path without that segment.
function toRawUrl(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
}

// DEFA14A is supplementary soliciting material and usually lacks the
// bio/comp tables — never fall back to it. Newest DEF 14A only.
export function pickLatestDef14A(filings) {
  if (!Array.isArray(filings)) return null;
  const def = filings
    .filter((f) => f && String(f.form) === 'DEF 14A' && f.url)
    .sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
  if (def.length === 0) return null;
  return { ...def[0], url: toRawUrl(def[0].url) };
}

// Real proxies are 0.3–2 MB. Cap defensively so a pathological response
// can't blow memory; node-html-parser handles a few MB cheaply.
const MAX_HTML = 4 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
export function _resetProxyCache() {
  cache.clear();
}

async function defaultFilingsFetch(ticker) {
  return getRecentFilings(ticker, { limit: 150 });
}
async function defaultDocFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`sec doc ${r.status}`);
  return r.text();
}

// { ticker, filedAt, url, html, _source }. Never throws.
export async function getProxyStatement(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  const empty = { ticker: sym, filedAt: null, url: null, html: '', _source: null };
  if (!sym) return empty;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const filingsFetch = deps.filingsFetch || defaultFilingsFetch;
  const docFetch = deps.docFetch || defaultDocFetch;

  let payload = empty;
  try {
    const filing = pickLatestDef14A(await filingsFetch(sym));
    if (filing) {
      const raw = await docFetch(filing.url);
      payload = {
        ticker: sym,
        filedAt: filing.filingDate || null,
        url: filing.url,
        html: String(raw || '').slice(0, MAX_HTML),
        _source: 'sec',
      };
    }
  } catch (err) {
    console.warn(`proxyStatement(${sym}) failed:`, err.message);
    payload = empty;
  }

  cache.set(sym, { at: Date.now(), payload });
  return payload;
}
