import prisma from '../db.js';

// SEC EDGAR backfill for historical Goldman Sachs FGTXX yields. The
// daily GSAM PDF only carries today's snapshot, so to compute YTD
// interest we backfill from Goldman Sachs Trust's monthly Form N-MFP3
// filings — each filing covers one month and contains a per-share-class
// `sevenDayNetYield` series with one entry per business day. Institutional
// Shares of "Goldman Sachs Financial Square Fund - Government" is FGTXX.
const GS_TRUST_CIK = '0000822977';
const SERIES_NAME = 'Goldman Sachs Financial Square Fund - Government';
// Default class to backfill. Institutional Shares of the FS Government
// Fund is FGTXX (classesId C000025196). The class is identified inside
// the filing by classFullName; we don't need the class id directly.
const TARGET_CLASS_FULL_NAME = 'Institutional Shares';
const TARGET_TICKER = 'FGTXX';

const UA = 'GriffinFund research@thegriffinfund.org';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`EDGAR ${res.status} for ${url}`);
  return res.text();
}

// Build the list of N-MFP3 filing accession numbers from GS Trust in
// the requested date window. We use the full-text search index because
// the alternative (parsing the EDGAR HTML browse pages) is brittle
// across pagination.
async function listFilings({ startDate, endDate }) {
  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);
  const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=N-MFP3&ciks=${GS_TRUST_CIK}&dateRange=custom&startdt=${start}&enddt=${end}`;
  const data = await fetchJson(url);
  return (data?.hits?.hits || []).map((h) => h._source.adsh);
}

function primaryDocUrl(adsh) {
  const noDash = adsh.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${parseInt(GS_TRUST_CIK, 10)}/${noDash}/primary_doc.xml`;
}

// Pull every <sevenDayNetYield> entry inside the first <classLevelInfo>
// whose <classFullName> matches the target class. Filings carry several
// classLevelInfo blocks (one per share class); we want the Institutional
// one. Regex is enough here — the XML is well-formed and the tag set is
// stable across filings.
function extractYields(xml, targetClassFullName) {
  if (!xml.includes(`<nameOfSeries>${SERIES_NAME}</nameOfSeries>`)) {
    return [];
  }
  // Walk classLevelInfo blocks one at a time so we don't accidentally
  // grab yields from a different share class.
  const blockRe = /<classLevelInfo>([\s\S]*?)<\/classLevelInfo>/g;
  let match;
  while ((match = blockRe.exec(xml)) !== null) {
    const block = match[1];
    const nameMatch = block.match(/<classFullName>([^<]+)<\/classFullName>/);
    if (!nameMatch || nameMatch[1].trim() !== targetClassFullName) continue;
    // Found the right block — extract every (date, value) pair.
    const out = [];
    const yieldRe =
      /<sevenDayNetYield>\s*<sevenDayNetYieldValue>([^<]+)<\/sevenDayNetYieldValue>\s*<sevenDayNetYieldDate>([^<]+)<\/sevenDayNetYieldDate>\s*<\/sevenDayNetYield>/g;
    let y;
    while ((y = yieldRe.exec(block)) !== null) {
      const value = Number(y[1]);
      const date = new Date(`${y[2]}T00:00:00Z`);
      if (Number.isFinite(value) && !Number.isNaN(date.getTime())) {
        out.push({ date, value });
      }
    }
    return out;
  }
  return [];
}

// Backfill all Government Fund Institutional Shares 7-day net yields
// in the window, upserting one row per business day into
// MmfYieldSnapshot. Idempotent — re-running just refreshes any rows
// that the filings have since amended.
export async function backfillFgtxxFromEdgar({
  startDate = new Date(Date.UTC(2025, 9, 1)), // Oct 1, 2025
  endDate = new Date(),
} = {}) {
  const adshList = await listFilings({ startDate, endDate });
  const stats = { filings: 0, matched: 0, yieldsStored: 0, skipped: [] };

  for (const adsh of adshList) {
    stats.filings += 1;
    let xml;
    try {
      xml = await fetchText(primaryDocUrl(adsh));
    } catch (err) {
      stats.skipped.push({ adsh, reason: err.message });
      continue;
    }
    const yields = extractYields(xml, TARGET_CLASS_FULL_NAME);
    if (yields.length === 0) continue;
    stats.matched += 1;

    for (const y of yields) {
      // Stored as a percent so it matches the daily PDF row (e.g. 3.52)
      // — the N-MFP value is a decimal fraction (0.0352), so multiply.
      const sevenDayCurrentYield = y.value * 100;
      await prisma.mmfYieldSnapshot.upsert({
        where: { ticker_date: { ticker: TARGET_TICKER, date: y.date } },
        create: {
          ticker: TARGET_TICKER,
          date: y.date,
          sevenDayCurrentYield,
        },
        update: { sevenDayCurrentYield },
      });
      stats.yieldsStored += 1;
    }
  }
  return stats;
}
