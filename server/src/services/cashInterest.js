import prisma from '../db.js';

// Forward-simulation accounting for the club's two cash accounts.
// State is derived from a known starting point + a deposit schedule
// rather than from the brokerage sheet's daily cashValue — the sheet
// gives us *combined* cash, which is too lossy to distinguish the
// BDA sleeve from the FGTXX sleeve.
//
// Per the operations spec (Oct 17 2025 reset):
//   BDA (Goldman Sachs Bank USA Deposit) starts at $60,000 and pays a
//   flat 3.00% APY, daily compounding. One $25,000 deposit on Jan 29,
//   2026 (matches CASH_FLOWS in the client). No withdrawals to date.
//
//   FGTXX (GS Financial Square Government Fund, Institutional Shares)
//   starts at $40,000. Daily 7-day net yield is read from the
//   MmfYieldSnapshot table — backfilled from SEC N-MFP3 filings for
//   historical days, kept current by the daily GSAM PDF scrape going
//   forward. Dividends reinvest daily into the share balance. No
//   withdrawals or additional contributions.
//
// The simulation runs from BDA_START_DATE through `endDate` (default
// today) one calendar day at a time, compounding daily on the
// end-of-day balance. Weekends and holidays use the most recent
// observed FGTXX yield (forward-fill), matching how a real MMF accrues
// over non-business days.

export const FGTXX_TICKER = 'FGTXX';
export const FGTXX_PRINCIPAL = 40_000;
export const BDA_PRINCIPAL = 60_000;
export const BDA_APY = 0.03;
// 2025-10-17 (UTC midnight). Day-zero of the simulation: the $40k seed
// has just landed in FGTXX, BDA stands at $60k.
export const SIMULATION_START = new Date(Date.UTC(2025, 9, 17));
// Scheduled deposits into BDA. Add new tuples in chronological order
// — the loop assumes a tiny list so we don't bother building an index.
export const BDA_DEPOSITS = [
  { date: new Date(Date.UTC(2026, 0, 29)), amount: 25_000 },
];
// Last-resort yield if MmfYieldSnapshot is completely empty (e.g. the
// scraper hasn't run and the N-MFP backfill hasn't been kicked off
// yet). Matches the low end of the FGTXX yield range over the period.
const FGTXX_FALLBACK_APY = 0.035;

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d, n) {
  const copy = new Date(d.getTime());
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

function sameUtcDay(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

// Build a forward-fill yield lookup: for any calendar day, returns
// the APY (as a decimal — 0.0352 for 3.52%) from the most recent stored
// snapshot whose date is <= the lookup date. Binary search keeps the
// per-day cost O(log N).
function buildYieldLookup(yieldRows) {
  const rows = yieldRows
    .filter((r) => typeof r.sevenDayCurrentYield === 'number')
    .map((r) => ({ date: r.date, apy: r.sevenDayCurrentYield / 100 }))
    .sort((a, b) => a.date - b.date);
  return function lookup(date) {
    if (rows.length === 0) return { apy: FGTXX_FALLBACK_APY, source: 'fallback' };
    let lo = 0;
    let hi = rows.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].date <= date) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best === -1) {
      // Date precedes anything we've stored. Use the earliest known
      // value as a backward-fill — better than the fallback constant
      // because it at least reflects the rate regime.
      return { apy: rows[0].apy, source: 'backward-fill' };
    }
    return { apy: rows[best].apy, source: 'observed' };
  };
}

export async function computeCashInterest({ endDate } = {}) {
  const end = startOfUtcDay(endDate || new Date());

  const yieldRows = await prisma.mmfYieldSnapshot.findMany({
    where: { ticker: FGTXX_TICKER },
    orderBy: { date: 'asc' },
    select: { date: true, sevenDayCurrentYield: true },
  });
  const lookupYield = buildYieldLookup(yieldRows);

  // Day-zero state. The BDA $60k and FGTXX $40k are end-of-day-Oct-16
  // balances; the loop accrues interest *for* Oct 17 on day one.
  let bda = BDA_PRINCIPAL;
  let fgtxx = FGTXX_PRINCIPAL;
  let bdaInterestTotal = 0;
  let fgtxxInterestTotal = 0;
  const series = [];

  let day = new Date(SIMULATION_START.getTime());
  while (day <= end) {
    // Deposits land at start-of-day, so they earn that day's interest
    // too. The actual cash hit in real life is at the close — but the
    // difference is one day of interest on $25k at 3%, about $2 — well
    // inside the noise of the model.
    let depositToday = 0;
    for (const d of BDA_DEPOSITS) {
      if (sameUtcDay(d.date, day)) {
        bda += d.amount;
        depositToday += d.amount;
      }
    }

    const { apy: fgtxxApy, source: yieldSource } = lookupYield(day);
    const bdaInterest = (bda * BDA_APY) / 365;
    const fgtxxInterest = (fgtxx * fgtxxApy) / 365;

    bda += bdaInterest;
    fgtxx += fgtxxInterest;
    bdaInterestTotal += bdaInterest;
    fgtxxInterestTotal += fgtxxInterest;

    series.push({
      date: new Date(day.getTime()),
      bdaBalance: bda,
      fgtxxBalance: fgtxx,
      bdaInterest,
      fgtxxInterest,
      fgtxxYieldApy: fgtxxApy,
      yieldSource,
      deposit: depositToday || null,
    });

    day = addDays(day, 1);
  }

  const latestStored = yieldRows[yieldRows.length - 1] || null;

  return {
    // New canonical field names from the spec
    bdaTotalInterest: bdaInterestTotal,
    fgtxxTotalInterest: fgtxxInterestTotal,
    totalInterest: bdaInterestTotal + fgtxxInterestTotal,
    bdaEndingBalance: bda,
    fgtxxEndingBalance: fgtxx,
    combinedEndingValue: bda + fgtxx,
    daysSimulated: series.length,
    asOf: series[series.length - 1]?.date ?? end,
    fgtxxLatestYield: latestStored?.sevenDayCurrentYield ?? null,
    fgtxxLatestYieldDate: latestStored?.date ?? null,
    bdaApy: BDA_APY,
    simulationStart: SIMULATION_START,
    bdaPrincipal: BDA_PRINCIPAL,
    fgtxxPrincipal: FGTXX_PRINCIPAL,
    deposits: BDA_DEPOSITS,
    // Back-compat aliases so the existing Dashboard card keeps
    // rendering without churn. Remove these when the card is rewritten
    // to the new field names.
    ytdBankInterest: bdaInterestTotal,
    ytdFgtxxInterest: fgtxxInterestTotal,
    ytdTotalInterest: bdaInterestTotal + fgtxxInterestTotal,
    currentFgtxxBalance: fgtxx,
    currentBankBalance: bda,
    latestFgtxxYield: latestStored?.sevenDayCurrentYield ?? null,
    latestFgtxxYieldDate: latestStored?.date ?? null,
    bankApy: BDA_APY,
    fgtxxStartDate: SIMULATION_START,
    daysCounted: series.length,
    series,
  };
}
