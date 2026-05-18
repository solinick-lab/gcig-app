import prisma from '../db.js';
import { getSheetPortfolio } from './sheetPortfolio.js';

// Real accounting for the club's two cash sleeves — no simulation.
//
// History of what actually happened (per the treasurer): at inception
// in October 2025 the club placed $40,000 into FGTXX (the GS Financial
// Square Government money-market fund) and $60,000 into BDA (the GS
// Bank USA deposit). As the club bought stocks it drew the cash down —
// BDA first, until it was emptied, then FGTXX. Today BDA is closed
// ($0) and FGTXX holds only what's left after the buys.
//
// Crucially that remaining FGTXX cash IS the brokerage sheet's CASH
// line, and every dollar that was drawn down became a stock position
// that the sheet already prices. So the club's entire economic
// position — cash sleeves included — is already inside the sheet's
// total. There is nothing to add on top: the old "forward simulation"
// that compounded a no-withdrawals $125k balance was inventing money
// the club had actually spent, and double-counting it against the
// equities the cash had turned into.
//
// What this module now reports:
//   * the real sleeve balances — BDA $0, FGTXX = the live sheet cash;
//   * a rough ESTIMATE of the interest those sleeves threw off while
//     the money sat idle, for context only. It is informational and is
//     NEVER added to portfolio totals or returns (those dividends
//     reinvested into the balances, or were spent on stock — either
//     way the sheet already carries them).

// Inception: the seed split landed in October 2025.
export const INCEPTION = new Date(Date.UTC(2025, 9, 17));
// Seed principal.
const BDA_SEED = 60_000;
const FGTXX_SEED = 40_000;
// The $25k capital infusion went into BDA on Jan 29, 2026 (mirrors
// CASH_FLOWS in the client).
const BDA_INFUSION = { date: new Date(Date.UTC(2026, 0, 29)), amount: 25_000 };
// Flat APY the bank deposit paid.
export const BDA_APY = 0.03;
// Reasonable blended yield for the FGTXX sleeve over the period when no
// observed 7-day yield is available. The fund ran roughly 3.5% net.
const FGTXX_ASSUMED_APY = 0.035;

function yearsBetween(a, b) {
  return Math.max(0, (b - a) / (365.25 * 24 * 60 * 60 * 1000));
}

// Estimate the interest a sleeve threw off while it was being drawn
// down. We don't have the per-purchase drawdown schedule, so we assume
// each tranche declined roughly linearly from when it landed to its
// ending balance today. The time-average of a linear glide from P0 to
// P1 is simply (P0 + P1) / 2, so interest ≈ avg balance × rate × years.
// This is deliberately a back-of-envelope figure — it's labelled an
// estimate everywhere it surfaces.
function estimateInterest({ tranches, endBalance, rate, end }) {
  // Distribute the (small) ending balance across tranches by weight so
  // the averages don't double-count it.
  const totalSeed = tranches.reduce((s, t) => s + t.amount, 0);
  let total = 0;
  for (const t of tranches) {
    const share = totalSeed > 0 ? (t.amount / totalSeed) * endBalance : 0;
    const avg = (t.amount + share) / 2;
    total += avg * rate * yearsBetween(t.date, end);
  }
  return total;
}

// Latest observed FGTXX 7-day net yield, if we have one — purely so the
// card can show the real headline rate. Falls back to the assumed APY.
async function latestFgtxxYield() {
  try {
    const row = await prisma.mmfYieldSnapshot.findFirst({
      where: { ticker: 'FGTXX', sevenDayCurrentYield: { not: null } },
      orderBy: { date: 'desc' },
      select: { date: true, sevenDayCurrentYield: true },
    });
    return row || null;
  } catch {
    return null;
  }
}

export async function computeCashInterest({ endDate } = {}) {
  const end = endDate ? new Date(endDate) : new Date();

  // Real balances. BDA was emptied buying stocks; FGTXX is whatever the
  // brokerage sheet's cash line says it is right now. If the sheet read
  // fails we still return BDA $0 and a null FGTXX rather than guessing.
  let fgtxxBalance = null;
  try {
    const sheet = await getSheetPortfolio();
    fgtxxBalance = Number(sheet?.totals?.cashValue) || 0;
  } catch {
    fgtxxBalance = null;
  }
  const bdaBalance = 0;

  const yieldRow = await latestFgtxxYield();
  const fgtxxApy = yieldRow?.sevenDayCurrentYield != null
    ? yieldRow.sevenDayCurrentYield / 100
    : FGTXX_ASSUMED_APY;

  // Informational estimate of interest earned while the sleeves were
  // funded. Not added to anything.
  const bdaEstimatedInterest = estimateInterest({
    tranches: [
      { date: INCEPTION, amount: BDA_SEED },
      { date: BDA_INFUSION.date, amount: BDA_INFUSION.amount },
    ],
    endBalance: bdaBalance,
    rate: BDA_APY,
    end,
  });
  const fgtxxEstimatedInterest = estimateInterest({
    tranches: [{ date: INCEPTION, amount: FGTXX_SEED }],
    endBalance: fgtxxBalance ?? 0,
    rate: fgtxxApy,
    end,
  });
  const estimatedInterestEarned = bdaEstimatedInterest + fgtxxEstimatedInterest;

  return {
    // Real, current state.
    bdaBalance,
    fgtxxBalance,
    combinedBalance: (fgtxxBalance ?? 0) + bdaBalance,
    asOf: end,
    bdaApy: BDA_APY,
    fgtxxYieldApy: fgtxxApy,
    fgtxxLatestYield: yieldRow?.sevenDayCurrentYield ?? null,
    fgtxxLatestYieldDate: yieldRow?.date ?? null,
    inception: INCEPTION,

    // Rough, informational-only estimate. NEVER fold into totals — the
    // sheet already carries every dollar of this (reinvested into the
    // FGTXX balance or spent on stock the sheet prices).
    estimatedInterestEarned,
    bdaEstimatedInterest,
    fgtxxEstimatedInterest,
    isEstimate: true,

    // Back-compat aliases for older callers. `totalInterest` is forced
    // to 0 so any lingering `totalValue + totalInterest` adder is a
    // no-op rather than a silent double-count; the real (estimate)
    // figure lives in `estimatedInterestEarned`.
    totalInterest: 0,
    bdaTotalInterest: bdaEstimatedInterest,
    fgtxxTotalInterest: fgtxxEstimatedInterest,
    bdaEndingBalance: bdaBalance,
    fgtxxEndingBalance: fgtxxBalance,
    combinedEndingValue: (fgtxxBalance ?? 0) + bdaBalance,
    bdaPrincipal: BDA_SEED + BDA_INFUSION.amount,
    fgtxxPrincipal: FGTXX_SEED,
    daysSimulated: Math.max(1, Math.round((end - INCEPTION) / 86_400_000)),
    series: [],
  };
}
