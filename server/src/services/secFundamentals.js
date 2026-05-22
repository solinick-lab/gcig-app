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
export function extractConcept(facts, candidates, { unit, freq, instant = false }) {
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
    if (e.val == null || e.fy == null || !e.end) continue;
    // Income-statement and cash-flow lines are *durations* (a quarter or
    // a year of activity); balance-sheet lines are *instants* (a snapshot
    // at period end, tagged with only an `end`). The duration window
    // separates annual from quarterly flows; instants skip it and lean on
    // the fiscal-period tag alone.
    if (!instant) {
      if (!e.start) continue;
      const d = daysBetween(e.start, e.end);
      if (freq === 'annual' && !(d >= 350 && d <= 380)) continue;
      if (freq === 'quarterly' && !(d >= 80 && d <= 100)) continue;
    }

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

// ── FA: the full statements ───────────────────────────────────────────
// GF lifts a handful of headline metrics to graph; FA reproduces the
// three statements line by line, the way Bloomberg's FA lays them out.
// Same companyfacts source, the same concept-drift candidate lists, and
// the instant/duration split extractConcept now understands. The line
// order here is the print order in the panel.

const INCOME_DEFS = [
  { key: 'revenue', label: 'Revenue', concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'] },
  { key: 'cogs', label: 'COGS', concepts: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'] },
  { key: 'grossProfit', label: 'Gross Profit', concepts: ['GrossProfit'] },
  { key: 'sga', label: 'SG&A Expense', concepts: ['SellingGeneralAndAdministrativeExpense'] },
  { key: 'rnd', label: 'R&D Expense', concepts: ['ResearchAndDevelopmentExpense'] },
  { key: 'opex', label: 'Operating Expenses', concepts: ['OperatingExpenses', 'CostsAndExpenses'] },
  { key: 'operatingIncome', label: 'Operating Income', concepts: ['OperatingIncomeLoss'] },
  { key: 'otherIncome', label: 'Other Income/(Expense)', concepts: ['NonoperatingIncomeExpense', 'OtherNonoperatingIncomeExpense'] },
  { key: 'pretaxIncome', label: 'Pretax Income', concepts: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'] },
  { key: 'incomeTax', label: 'Income Taxes', concepts: ['IncomeTaxExpenseBenefit'] },
  { key: 'netIncome', label: 'Net Income', concepts: ['NetIncomeLoss'] },
  { key: 'epsDiluted', label: 'Diluted EPS', unit: 'USD/shares', derive: false, concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'] },
  { key: 'dilutedShares', label: 'Diluted Shares', unit: 'shares', derive: false, concepts: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'] },
];

const BALANCE_DEFS = [
  { key: 'cash', label: 'Cash & Equivalents', concepts: ['CashAndCashEquivalentsAtCarryingValue'] },
  { key: 'sti', label: 'Short-Term Investments', concepts: ['ShortTermInvestments'] },
  { key: 'receivables', label: 'Receivables', concepts: ['AccountsReceivableNetCurrent'] },
  { key: 'inventory', label: 'Inventory', concepts: ['InventoryNet'] },
  { key: 'currentAssets', label: 'Total Current Assets', concepts: ['AssetsCurrent'] },
  { key: 'ppe', label: 'Net PP&E', concepts: ['PropertyPlantAndEquipmentNet'] },
  { key: 'totalAssets', label: 'Total Assets', concepts: ['Assets'] },
  { key: 'currentLiabilities', label: 'Total Current Liabilities', concepts: ['LiabilitiesCurrent'] },
  { key: 'longTermDebt', label: 'Long-Term Debt', concepts: ['LongTermDebtNoncurrent', 'LongTermDebt'] },
  { key: 'totalLiabilities', label: 'Total Liabilities', concepts: ['Liabilities'] },
  { key: 'equity', label: 'Total Equity', concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
];

const CASHFLOW_DEFS = [
  { key: 'cfo', label: 'Operating Cash Flow', concepts: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'] },
  { key: 'capex', label: 'Capital Expenditures', concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'] },
  { key: 'cfi', label: 'Investing Cash Flow', concepts: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'] },
  { key: 'cff', label: 'Financing Cash Flow', concepts: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'] },
  { key: 'depreciation', label: 'D&A', concepts: ['DepreciationDepletionAndAmortization', 'DepreciationAmortizationAndAccretionNet', 'DepreciationAndAmortization'] },
  { key: 'sbc', label: 'Stock-Based Comp', concepts: ['ShareBasedCompensation'] },
  { key: 'dividends', label: 'Dividends Paid', concepts: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'] },
];

// companyfacts is a megabyte-plus per filer; cache the raw document so FA
// and a later GF call on the same name share one fetch.
const factsCache = new Map(); // CIK → { at, facts }
async function loadFacts(cik) {
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.facts;
  const facts = await fetchFacts(cik);
  factsCache.set(cik, { at: Date.now(), facts });
  return facts;
}

// Most filers tag Q1–Q3 and only the full year, never Q4. For an
// additive flow line we recover Q4 as FY − (Q1+Q2+Q3); for a balance
// snapshot the fiscal-year-end instant *is* the Q4 close, so we carry it
// straight over. Per-share and share-count lines aren't additive, so
// they opt out (derive:false) and simply go blank for Q4.
function pointsWithQ4(facts, def, instant) {
  const q = extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'quarterly', instant });
  const a = extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'annual', instant });
  for (const [, ap] of a) {
    const key = `${ap.fy} Q4`;
    if (q.has(key)) continue;
    if (instant) {
      q.set(key, { period: key, fy: ap.fy, fp: 'Q4', t: ap.t, val: ap.val });
    } else if (def.derive !== false) {
      const q1 = q.get(`${ap.fy} Q1`);
      const q2 = q.get(`${ap.fy} Q2`);
      const q3 = q.get(`${ap.fy} Q3`);
      if (q1 && q2 && q3 && [q1, q2, q3, ap].every((p) => p.val != null)) {
        q.set(key, { period: key, fy: ap.fy, fp: 'Q4', t: ap.t, val: ap.val - q1.val - q2.val - q3.val });
      }
    }
  }
  return q;
}

// Public: the three statements for a ticker, line items as rows and
// fiscal periods as columns (oldest→newest), aligned on a shared period
// axis so the columns line up across statements. Values are raw (USD,
// USD/shares, or share count); the panel handles millions/EPS display.
export async function getStatements(rawTicker, freq = 'annual') {
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
  const facts = await loadFacts(info.cik);

  const build = (defs, instant) =>
    defs.map((def) => ({
      ...def,
      points:
        wantFreq === 'quarterly'
          ? pointsWithQ4(facts, def, instant)
          : extractConcept(facts, def.concepts, { unit: def.unit || 'USD', freq: 'annual', instant }),
    }));

  const income = build(INCOME_DEFS, false);
  const balance = build(BALANCE_DEFS, true);
  const cashflow = build(CASHFLOW_DEFS, false);

  // Shared period axis: the union of every period any line reported.
  const pmap = new Map();
  for (const grp of [income, balance, cashflow]) {
    for (const item of grp) {
      for (const [k, p] of item.points) {
        if (!pmap.has(k)) pmap.set(k, { period: k, t: p.t, fy: p.fy, fp: p.fp });
      }
    }
  }
  const periods = Array.from(pmap.values())
    .sort((a, b) => a.t - b.t)
    .map((p) => ({
      period: p.period,
      fy: p.fy,
      fp: p.fp,
      label: wantFreq === 'annual' ? `FY ${p.fy}` : `${p.fp} ${p.fy}`,
    }));

  const toRows = (grp) =>
    grp.map((item) => ({
      key: item.key,
      label: item.label,
      unit: item.unit || 'USD',
      values: periods.map((per) => {
        const pt = item.points.get(per.period);
        return pt ? pt.val : null;
      }),
    }));

  return {
    ticker,
    cik: info.cik,
    name: info.name,
    freq: wantFreq,
    periods,
    income: toRows(income),
    balance: toRows(balance),
    cashflow: toRows(cashflow),
  };
}
