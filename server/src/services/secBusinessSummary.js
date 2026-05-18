// A company's plain-language description lives in Item 1 ("Business") of
// its annual report. Finnhub's free tier doesn't carry one and Yahoo's
// profile endpoint is blocked from datacenter IPs, but EDGAR is reachable
// from Render with nothing more than a descriptive User-Agent — the same
// path the rest of secFilings.js already uses.
//
// The fragile bit is the 10-K HTML: "Item 1. Business" shows up first as
// a table-of-contents link and only later as the real header, the section
// closes at "Item 1A." (or "Item 2." for filers predating Risk Factors),
// and the markup is entity- and tag-soup. extractItem1Business is the
// pure, tested core of that; getBusinessSummary is thin glue over the
// existing CIK/filings lookup.

import { getLatestFilingByForm, SEC_UA } from './secFilings.js';

// Inline tags vanish with no gap ("<b>Acme</b>Co" -> "AcmeCo"); anything
// structural becomes whitespace so a header can't fuse to its body.
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

// Newlines are kept at block boundaries on purpose: a real section
// header sits alone on its own line, whereas a cross-reference ("...set
// forth in Part I, "Item 1. Business" of this report...") is embedded
// mid-sentence. That structural difference is the only reliable way to
// tell the real Item 1 from the dozens of times the phrase is cited.
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

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// Headers must match in their *title* form. A bare "Item 1A" also occurs
// as a prose cross-reference ("See Item 1A of Part I — Risk Factors"),
// which would chop the description off after one sentence; requiring
// "Risk Factors" / "Properties" right after the number skips those. The
// number is anchored so "Item 1A" / "Item 10" can't satisfy "Item 1".
const ITEM1 = /\bitem\s+1\.?\s*[-—:]?\s*business\b/gi;
const ITEM1A = /\bitem\s+1a\.?\s*[-—:]?\s*risk\s+factors\b/gi;
const ITEM2 = /\bitem\s+2\.?\s*[-—:]?\s*propert/gi;

function endsOf(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) out.push(m.index);
  return out;
}

export function extractItem1Business(html) {
  const text = htmlToText(html);

  // "Item 1. Business" appears in the table of contents, as the real
  // section header, and sometimes as a later cross-reference. Rather
  // than guess which, pair every candidate start with its closing
  // header (Item 1A · Risk Factors, or Item 2 · Properties for filers
  // predating Risk Factors) and keep the pairing that yields the most
  // text — the real Business section dwarfs a TOC row or a stray "see
  // Item 1. Business" reference.
  const starts = [...text.matchAll(ITEM1)]
    .filter((m) => m.index === 0 || text[m.index - 1] === '\n')
    .map((m) => m.index + m[0].length);
  if (starts.length === 0) return null;

  const closers = endsOf(text, ITEM1A);
  const fallback = endsOf(text, ITEM2);

  let best = null;
  for (const s of starts) {
    let end = closers.find((i) => i > s);
    if (end == null) end = fallback.find((i) => i > s);
    if (end == null) continue;
    if (!best || end - s > best.end - best.s) best = { s, end };
  }
  if (!best) return null;

  const body = collapse(text.slice(best.s, best.end));
  return body || null;
}

// 10-Ks are annual; once we've parsed one, hold it for a week so a click
// storm doesn't re-pull a multi-megabyte filing.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new Map();

// EDGAR's Item 1 can run many pages of legalese; the DES panel wants a
// description, not the whole filing. Keep a generous slice ending on a
// sentence boundary.
const MAX_CHARS = 3500;

function trimToSentence(s) {
  if (s.length <= MAX_CHARS) return s;
  const cut = s.slice(0, MAX_CHARS);
  const dot = cut.lastIndexOf('. ');
  return (dot > MAX_CHARS * 0.5 ? cut.slice(0, dot + 1) : cut).trim() + ' […]';
}

export async function getBusinessSummary(ticker) {
  const key = String(ticker || '').trim().toUpperCase();
  if (!key) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;
  try {
    const tenK = await getLatestFilingByForm(key, /^10-K(405|SB)?$/i);
    if (tenK?.url) {
      const r = await fetch(tenK.url, {
        headers: { 'User-Agent': SEC_UA, Accept: 'text/html' },
      });
      if (r.ok) {
        const item1 = extractItem1Business(await r.text());
        if (item1) value = trimToSentence(item1);
      }
    }
  } catch {
    value = null;
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
