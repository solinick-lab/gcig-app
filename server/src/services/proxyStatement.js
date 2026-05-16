// MGMT spine. Everything in MGMT derives from one document: the
// company's latest DEF 14A proxy. We locate it via the same SEC
// submissions feed secFilings.js already uses, fetch the primary HTML,
// flatten to text, and split into the named sections the parsers want.
// Best-effort and never throws — a missing proxy or section yields
// null, never an error (same contract as services/worldIndices.js).
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

// The DEF 14A document also lives on sec.gov — it must carry the same
// SEC-compliant declarative UA secFilings.js uses. The old Chrome UA
// here got the Archives fetch blocked from Render's datacenter IP, so
// docFetch threw and getProxyStatement collapsed to _source:null
// ("No DEF 14A on file") for every ticker in production.
const UA = SEC_UA;

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"', '&apos;': "'" };

// Dependency-free: drop script/style, strip tags, decode the handful of
// entities SEC proxies actually use, collapse whitespace. Good enough
// for keyword section-splitting and line/number extraction.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x[0-9a-f]+;/gi, ' ')
    .replace(/&#\d+;|&[a-z]+;/gi, (m) => (ENTITIES[m.toLowerCase()] ?? ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Heading keywords → section bucket. We scan for the first occurrence
// of each anchor and slice from it to the next anchor. Recall over
// precision: a section we cannot find is simply null.
const ANCHORS = [
  { key: 'board', re: /\bELECTION OF DIRECTORS\b|\bNOMINEES? FOR DIRECTOR\b|\bBOARD OF DIRECTORS\b/i },
  { key: 'dirComp', re: /\bDIRECTOR COMPENSATION\b/i },
  { key: 'execBios', re: /\bEXECUTIVE OFFICERS\b|\bINFORMATION ABOUT (OUR )?EXECUTIVE OFFICERS\b/i },
  { key: 'comp', re: /\bSUMMARY COMPENSATION TABLE\b/i },
];

export function splitSections(text) {
  const t = String(text || '');
  const hits = [];
  for (const a of ANCHORS) {
    const m = a.re.exec(t);
    if (!m) continue;
    let at = m.index;
    // DEF 14As open with a TOC that lists every heading with a page
    // number. If the first hit is in the leading 15% of the document,
    // prefer a later occurrence — the body heading carries the real
    // content; the TOC entry is just "<HEADING> 12".
    if (m.index < t.length * 0.15) {
      const rest = t.slice(m.index + m[0].length);
      const m2 = a.re.exec(rest);
      if (m2) at = m.index + m[0].length + m2.index;
    }
    hits.push({ key: a.key, at });
  }
  hits.sort((x, y) => x.at - y.at);
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : t.length;
    out[hits[i].key] = t.slice(hits[i].at, end).trim();
  }
  return out;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
export function _resetProxyCache() {
  cache.clear();
}

async function defaultFilingsFetch(ticker) {
  return getRecentFilings(ticker, { limit: 150 });
}
async function defaultDocFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`sec doc ${r.status}`);
  return r.text();
}

// { ticker, filedAt, url, sections, _source }. Never throws.
export async function getProxyStatement(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  const empty = { ticker: sym, filedAt: null, url: null, sections: {}, _source: null };
  if (!sym) return empty;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const filingsFetch = deps.filingsFetch || defaultFilingsFetch;
  const docFetch = deps.docFetch || defaultDocFetch;

  let payload = empty;
  try {
    const filing = pickLatestDef14A(await filingsFetch(sym));
    if (filing) {
      const html = await docFetch(filing.url);
      payload = {
        ticker: sym,
        filedAt: filing.filingDate || null,
        url: filing.url,
        sections: splitSections(htmlToText(html)),
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
