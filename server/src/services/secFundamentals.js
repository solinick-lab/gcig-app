import { getCikForTicker, SEC_UA } from './secFilings.js';

// SEC XBRL companyfacts — the structured financial-statement numbers a
// company tags in its filings, the same source Bloomberg's GF graphs.
// One fetch per CIK returns every us-gaap concept it has ever reported;
// we lift a handful (revenue → operating cash flow, plus diluted EPS),
// normalize them into per-period rows, and derive the margins. Free, no
// key — SEC only wants the identifying User-Agent.
//
// Two XBRL gotchas this service exists to absorb:
//   1. Concept names drift. "Revenue" has been Revenues, then
//      SalesRevenueNet, now RevenueFromContractWithCustomerExcluding-
//      AssessedTax; we try the candidates in order and take the first
//      tag the filer actually used.
//   2. A 10-K carries the full-year figure *and* the trailing quarters
//      for the same line. We keep annual points by period duration
//      (~a year) and dedupe each fiscal year to its latest filing, so a
//      restatement supersedes the original number.

const FACTS_URL = (cik) =>
  `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

const TTL_MS = 24 * 60 * 60 * 1000; // 24h — fundamentals move quarterly
const cache = new Map(); // CIK → { at, value: { annual, quarterly } }

// Metric → ordered concept candidates. The first one the filer reports
// wins. EPS carries the per-share unit; the rest are plain USD.
const METRICS = [
  {
    key: 'revenue',
    label: 'Revenue',
    unit: 'USD',
    concepts: [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'SalesRevenueNet',
    ],
  },
  { key: 'grossProfit', label: 'Gross Profit', unit: 'USD', concepts: ['GrossProfit'] },
  {
    key: 'operatingIncome',
    label: 'Operating Income',
    unit: 'USD',
    concepts: ['OperatingIncomeLoss'],
  },
  { key: 'netIncome', label: 'Net Income', unit: 'USD', concepts: ['NetIncomeLoss'] },
  {
    key: 'cfo',
    label: 'Operating Cash Flow',
    unit: 'USD',
    concepts: [
      'NetCashProvidedByUsedInOperatingActivities',
      'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
    ],
  },
  {
    key: 'epsDiluted',
    label: 'Diluted EPS',
    unit: 'USD/shares',
    concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  },
];

function daysBetween(start, end) {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

// Pull one metric's points for a frequency, keyed by fiscal period. The
// duration test does the heavy lifting: a year-long span is annual, a
// quarter-long span is quarterly, and the embedded sub-periods a 10-K
// also tags fall outside both windows. Each period is deduped to its
// most recently filed value so restatements win.
export function extractConcept(facts, candidates, { unit, freq }) {
  const root = facts?.facts?.['us-gaap'] || {};
  let entries = null;
  for (const c of candidates) {
    const u = root[c]?.units?.[unit];
    if (Array.isArray(u) && u.length) {
      entries = u;
      break;
    }
  }
  if (!entries) return new Map();

  const byPeriod = new Map();
  for (const e of entries) {
    if (e.val == null || e.fy == null || !e.start || !e.end) continue;
    const d = daysBetween(e.start, e.end);
    if (freq === 'annual' && !(d >= 350 && d <= 380)) continue;
    if (freq === 'quarterly' && !(d >= 80 && d <= 100)) continue;

    const fp = e.fp || (freq === 'annual' ? 'FY' : '');
    // The full-year line is fp 'FY'; a quarter is Q1–Q4. Belt-and-braces
    // alongside the duration test for filers with loose tagging.
    if (freq === 'annual' && fp !== 'FY') continue;
    if (freq === 'quarterly' && fp === 'FY') continue;

    const period = freq === 'annual' ? `FY${e.fy}` : `${e.fy} ${fp}`;
    const filed = e.filed || '';
    const prev = byPeriod.get(period);
    if (!prev || filed > prev.filed) {
      byPeriod.set(period, {
        period,
        fy: e.fy,
        fp,
        t: Date.parse(e.end),
        val: e.val,
        filed,
      });
    }
  }
  return byPeriod;
}

// Assemble every metric into period rows, oldest→newest, with margins
// derived wherever revenue is present and non-zero.
export function extractFundamentals(facts, freq = 'annual') {
  const perMetric = METRICS.map((m) => ({
    m,
    points: extractConcept(facts, m.concepts, { unit: m.unit, freq }),
  }));

  // Union of every period any metric reported, ordered by period end.
  const periods = new Map();
  for (const { points } of perMetric) {
    for (const [k, p] of points) {
      if (!periods.has(k)) periods.set(k, { period: k, t: p.t });
    }
  }

  return Array.from(periods.values())
    .sort((a, b) => a.t - b.t)
    .map((base) => {
      const row = { period: base.period, t: base.t };
      for (const { m, points } of perMetric) {
        const p = points.get(base.period);
        row[m.key] = p ? p.val : null;
      }
      const rev = row.revenue;
      const margin = (x) => (rev && x != null ? x / rev : null);
      row.grossMargin = margin(row.grossProfit);
      row.operatingMargin = margin(row.operatingIncome);
      row.netMargin = margin(row.netIncome);
      return row;
    });
}

async function fetchFacts(cik) {
  const controller = new AbortController();
  // companyfacts is a fat document (a megabyte-plus for old filers), so
  // a longer leash than the filings feed.
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(FACTS_URL(cik), {
      signal: controller.signal,
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      const err = new Error(`SEC companyfacts ${res.status}`);
      err.status = res.status === 404 ? 404 : 502;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Share-class symbols arrive dotted (BRK.B) but EDGAR's map is hyphen
// (BRK-B); try the symbol then both punctuation variants, like the
// filings service does.
async function resolveCik(ticker) {
  const t = String(ticker || '').toUpperCase();
  for (const v of [t, t.replace(/\./g, '-'), t.replace(/-/g, '.')]) {
    const hit = await getCikForTicker(v);
    if (hit) return hit;
  }
  return null;
}

// Public: normalized fundamentals for a ticker at the requested
// frequency. Both frequencies are built (and cached) from the single
// companyfacts fetch, so flipping annual↔quarterly is free after the
// first call. Throws { status } on a bad ticker or upstream failure; an
// empty rows array is a normal "this filer tags none of these".
export async function getFundamentals(rawTicker, freq = 'annual') {
  const ticker = String(rawTicker || '').trim().toUpperCase();
  if (!ticker || !/^[A-Z0-9.\-]{1,12}$/.test(ticker)) {
    const e = new Error('Invalid ticker');
    e.status = 400;
    throw e;
  }
  const wantFreq = freq === 'quarterly' ? 'quarterly' : 'annual';

  const info = await resolveCik(ticker);
  if (!info) {
    const e = new Error('Ticker not found in SEC EDGAR');
    e.status = 404;
    throw e;
  }

  const hit = cache.get(info.cik);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { ticker, cik: info.cik, name: info.name, freq: wantFreq, rows: hit.value[wantFreq] };
  }

  const facts = await fetchFacts(info.cik);
  const value = {
    annual: extractFundamentals(facts, 'annual'),
    quarterly: extractFundamentals(facts, 'quarterly'),
  };
  cache.set(info.cik, { at: Date.now(), value });
  return { ticker, cik: info.cik, name: info.name, freq: wantFreq, rows: value[wantFreq] };
}
