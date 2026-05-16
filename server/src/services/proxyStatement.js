// MGMT spine. Everything in MGMT derives from one document: the
// company's latest DEF 14A proxy. We locate it via the same SEC
// submissions feed secFilings.js already uses, fetch the primary HTML,
// flatten to text, and split into the named sections the parsers want.
// Best-effort and never throws — a missing proxy or section yields
// null, never an error (same contract as services/worldIndices.js).
import { getRecentFilings } from './secFilings.js';

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
