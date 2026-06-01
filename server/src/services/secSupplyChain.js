// SPLC — a grounded, free-tier shadow of Bloomberg's Supply Chain
// (SPLC). Bloomberg's value there is a proprietary graph of 500k+
// supplier/customer links with quantified revenue exposure; we have no
// such feed. What we *do* have, reachable from Render, is the company's
// own 10-K, where US filers must disclose any customer above 10% of
// revenue and routinely name principal suppliers, distributors, and raw
// materials. So we pull the latest 10-K, isolate the passages that talk
// about relationships, and have the LLM structure only what the filing
// actually names — percentages only where the text states them, empty
// when it says nothing. Nothing here is invented; the panel is honest
// about being a filing read, not a market-wide graph.

import { getLatestFilingByForm, SEC_UA } from './secFilings.js';
import { llmChat } from './llm.js';

const BLOCK_TAG =
  /<\/?(p|div|br|tr|td|th|table|thead|tbody|h[1-6]|li|ul|ol|section|article|header|footer|hr)\b[^>]*>/gi;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_TAG, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// The relationship language we care about. A 10-K is mostly boilerplate;
// these are the lines where a filer names who it buys from, who it sells
// to, and what it depends on.
const KEYWORDS =
  /\b(customers?|suppliers?|concentrat\w*|raw materials?|vendors?|distributors?|merchants?|accounted for|% of (?:net )?(?:revenue|sales)|depend\w+ (?:on|upon)|principal|contract manufacturers?|sourc\w+|procure\w*)\b/i;

// Pull the paragraphs that mention relationships, deduped and capped, so
// the LLM sees signal instead of a multi-megabyte filing.
function gatherPassages(text, cap = 9000) {
  const paras = text
    .split('\n')
    .map((s) => s.trim())
    .filter((p) => p.length > 40 && p.length < 1200 && KEYWORDS.test(p));
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const p of paras) {
    const key = p.slice(0, 90).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (total + p.length > cap) break;
    out.push(p);
    total += p.length;
  }
  return out.join('\n\n');
}

const SYSTEM =
  'You are a supply-chain analyst at the Griffin Fund, a student investment fund, reading excerpts from a company\'s 10-K annual report. ' +
  'Extract the named business relationships. Reply with STRICT JSON only — no prose, no code fences.\n' +
  'Shape: {"summary": string, "concentration": string|null, ' +
  '"customers": [{"name": string, "pct": number|null, "note": string}], ' +
  '"suppliers": [{"name": string, "note": string}], ' +
  '"materials": [{"name": string, "note": string}]}\n' +
  'Hard rules:\n' +
  '- Use ONLY names that appear verbatim in the excerpts. Never invent, infer, or supply a name from outside knowledge.\n' +
  '- "customers" and "suppliers" must be SPECIFICALLY NAMED companies, organizations, or government bodies — proper nouns like "Walmart", "Apple", "Taiwan Semiconductor", "U.S. Department of Defense". ' +
  'NEVER list customer or supplier *types, segments, audiences, or categories*: consumers, sellers, developers, enterprises, advertisers, content creators, employees, retailers, small businesses, individuals, users, subscribers, partners, merchants, distributors, vendors, government (generic). ' +
  'A diversified company that names no specific customer company has an empty "customers" array — that is the correct, expected answer, not a reason to pad with segments.\n' +
  '- "pct" is the share of revenue or sales a NAMED customer represents, as a number (12 means 12%), and ONLY when the text states it for that specific named customer; otherwise null. Never put 0.\n' +
  '- "materials" are concrete physical inputs ("aluminum", "cobalt", "semiconductors", "jet fuel"), never the phrase "raw materials" itself or "various inputs".\n' +
  '- If the excerpts name nothing concrete for a category, return an empty array for it.\n' +
  '- "concentration" is one sentence on any stated customer-concentration risk, or null if none is mentioned.\n' +
  '- "summary" is one or two sentences on the company\'s customer/supplier posture, grounded strictly in the excerpts.\n' +
  '- Each "note" is at most twelve words, in the filing\'s own framing.';

// A backstop against the model padding with customer/supplier *types*
// when a filing names no specific company (Amazon's "consumers, sellers,
// developers…"). These are categories, not relationships — drop them so
// the panel shows an honest empty state instead of a wall of 0% rows.
const GENERIC = new Set(
  [
    'consumers', 'consumer', 'customers', 'customer', 'sellers', 'seller', 'buyers', 'buyer',
    'developers', 'developer', 'enterprises', 'enterprise', 'businesses', 'business',
    'small businesses', 'large enterprises', 'advertisers', 'advertiser', 'content creators',
    'content creator', 'employees', 'employee', 'retailers', 'retailer', 'retail customers',
    'wholesalers', 'wholesaler', 'distributors', 'distributor', 'resellers', 'reseller',
    'merchants', 'merchant', 'individuals', 'individual', 'users', 'user', 'end users',
    'end user', 'subscribers', 'subscriber', 'members', 'member', 'clients', 'client',
    'partners', 'partner', 'suppliers', 'supplier', 'vendors', 'vendor', 'government',
    'governments', 'organizations', 'organization', 'institutions', 'institution',
    'general public', 'public', 'third parties', 'third party', 'various customers',
    'various suppliers', 'raw materials', 'materials', 'various', 'others',
  ].map((s) => s.toLowerCase())
);

function isGeneric(name) {
  return GENERIC.has(String(name || '').trim().toLowerCase());
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanEntity(e, withPct) {
  if (!e || typeof e !== 'object') return null;
  const name = String(e.name || '').trim().slice(0, 80);
  // Drop blanks and generic category words — those aren't relationships.
  if (!name || isGeneric(name)) return null;
  const out = { name, note: String(e.note || '').trim().slice(0, 90) };
  if (withPct) {
    const p = num(e.pct);
    // A real disclosed concentration is never 0%; treat 0 (and out-of-range)
    // as "not stated" so it renders as — rather than a phantom 0% bar.
    out.pct = p != null && p > 0 && p <= 100 ? p : null;
  }
  return out;
}

function sanitize(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const customers = arr(parsed.customers).map((e) => cleanEntity(e, true)).filter(Boolean).slice(0, 20);
  const suppliers = arr(parsed.suppliers).map((e) => cleanEntity(e, false)).filter(Boolean).slice(0, 20);
  const materials = arr(parsed.materials).map((e) => cleanEntity(e, false)).filter(Boolean).slice(0, 20);
  // Customers with a stated percentage lead, ranked; the rest follow.
  customers.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  return {
    summary: String(parsed.summary || '').trim().slice(0, 600),
    concentration: parsed.concentration ? String(parsed.concentration).trim().slice(0, 400) : null,
    customers,
    suppliers,
    materials,
  };
}

// 10-Ks are annual; hold a parsed result for a week so a click storm
// doesn't re-pull and re-summarize a multi-megabyte filing.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();

export async function getSupplyChain(ticker) {
  const key = String(ticker || '').trim().toUpperCase();
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  try {
    const tenK = await getLatestFilingByForm(key, /^10-K(405|SB)?$/i);
    if (tenK?.url) {
      const r = await fetch(tenK.url, { headers: { 'User-Agent': SEC_UA, Accept: 'text/html' } });
      if (r.ok) {
        const passages = gatherPassages(htmlToText(await r.text()));
        const base = {
          ticker: key,
          sourceForm: tenK.form,
          sourceDate: tenK.filingDate || null,
          sourceUrl: tenK.url,
        };
        if (passages) {
          const raw = await llmChat({ messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Company: ${key}\n\n10-K excerpts:\n${passages}` },
          ], jsonMode: true, temperature: 0, timeoutMs: 25_000 });
          let parsed = null;
          try {
            parsed = raw ? sanitize(JSON.parse(raw)) : null;
          } catch {
            parsed = null;
          }
          value = parsed
            ? { ...base, ...parsed }
            : { ...base, summary: '', concentration: null, customers: [], suppliers: [], materials: [] };
        } else {
          value = { ...base, summary: '', concentration: null, customers: [], suppliers: [], materials: [] };
        }
      }
    }
  } catch (err) {
    console.warn(`supply-chain(${key}) failed:`, err.message);
    value = null;
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
