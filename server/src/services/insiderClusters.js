import { getInsiderTransactions } from './insiderTx.js';
import { getHistory } from './priceHistory.js';

// ICLUSTER — the cluster scanner. Across a universe of tickers (v1
// is the fund's holdings, optionally + a watchlist if its route ships)
// surface names where ≥3 distinct insiders made open-market purchases
// in the last 60 days, weighted by role and dollar size, with a
// "buying into weakness" flag against the recent 90-day high.
//
// This is the analytic layer; it never fetches anything itself. Form 4
// data comes via insiderTx.js (Finnhub-primary, SEC-fallback,
// contractually never-throws), and the 90-day high comes off the
// PriceBar cache via priceHistory.js. Both are deps-injectable so the
// tests stay off the network.
//
// Per the locked methodology in
// docs/superpowers/specs/2026-05-20-insider-clusters-design.md: this
// is a screen, not a backtested forward signal. The route, the panel
// footer, and the AI brief all carry that framing.

const WINDOW_DAYS = 60;
const CLUSTER_THRESHOLD = 3;
const INTO_WEAKNESS_PCT = 0.9; // ≤90% of 90d high → into-weakness
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — same convention as secFilings
const SCAN_CONCURRENCY = 6;

const cache = new Map(); // TICKER -> { at, payload }

export function _resetInsiderClusters() {
  cache.clear();
}

// Role bucket weights per the spec. Form 4 only exposes buckets (no
// CEO/CFO distinction in the data — roleFromRelationship returns the
// officer title string when present, or "Director" / "10% Owner"
// otherwise), so weighting is at the bucket level by construction.
// Anything we can't classify falls to the unknown weight of 0.2.
function roleWeight(role) {
  if (!role) return 0.2;
  const r = String(role).trim();
  if (!r) return 0.2;
  if (/^director$/i.test(r)) return 0.6;
  if (/^10% owner$/i.test(r)) return 0.3;
  // Any non-empty role string that isn't "Director" or "10% Owner"
  // is an officer — either the literal "Officer" bucket or, more
  // commonly, the actual officer title ("CEO", "President and CEO",
  // "CFO", …) roleFromRelationship lifts from <officerTitle>.
  return 1.0;
}

// Distinct-insider key. Names from Finnhub arrive in a variety of
// formattings ("Cook Timothy D", "TIMOTHY D COOK", "Cook, Tim "); the
// upper-case + collapse-whitespace pass is the same normalization the
// chart overlays use to merge a single insider's same-day legs.
function insiderKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

// ISO yyyy-mm-dd → ms epoch. Returns NaN on a malformed date so the
// window filter naturally drops it.
function tsOf(dateStr) {
  return new Date(`${String(dateStr || '').slice(0, 10)}T00:00:00Z`).getTime();
}

// Default 90-day intraday high via priceHistory.js — the same
// Postgres PriceBar cache the GP chart and every other time-series
// surface reads from. We ask for the 3mo window (≥90 trading days
// of cushion), then take the max of the daily highs. Returns null
// when there's no data so the caller honestly surfaces "unknown" on
// the into-weakness flag, never silently false.
async function defaultGet90dHigh(ticker) {
  try {
    const bars = await getHistory(ticker, '3mo');
    if (!Array.isArray(bars) || bars.length === 0) return null;
    let hi = null;
    for (const b of bars) {
      const h = b.high != null ? Number(b.high) : null;
      if (Number.isFinite(h) && (hi == null || h > hi)) hi = h;
    }
    return hi;
  } catch {
    return null;
  }
}

// Default Form 4 fetcher — the shared insiderTx.js service. Returns
// the same { ticker, transactions, _source } shape INSDR consumes; we
// only need the transactions array here.
async function defaultGetTransactions(ticker) {
  const { transactions } = await getInsiderTransactions(ticker);
  return Array.isArray(transactions) ? transactions : [];
}

export async function getTickerCluster(ticker, deps = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return null;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const getTransactions = deps.getTransactions || defaultGetTransactions;
  const get90dHigh = deps.get90dHigh || defaultGet90dHigh;

  let result = null;
  try {
    const transactions = await getTransactions(sym);
    if (!Array.isArray(transactions) || transactions.length === 0) {
      cache.set(sym, { at: Date.now(), payload: null });
      return null;
    }

    // Keep only open-market purchases (Form 4 code P) inside the 60d
    // window, with both a share count and a price — without one we
    // can't dollar-weight the leg, so it's dropped honestly rather
    // than imputed.
    const cutoff = Date.now() - WINDOW_DAYS * 86_400_000;
    const qualifying = [];
    for (const t of transactions) {
      if (!t) continue;
      const code = String(t.code || '').toUpperCase();
      if (code !== 'P') continue;
      const ts = tsOf(t.date);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const shares = Number(t.shares);
      const price = Number(t.price);
      if (!Number.isFinite(shares) || shares <= 0) continue;
      if (!Number.isFinite(price) || price <= 0) continue;
      qualifying.push({
        ts,
        date: t.date,
        name: t.name || 'Unknown',
        key: insiderKey(t.name),
        role: t.role || null,
        shares,
        price,
        dollars: shares * price,
      });
    }

    // Distinct-insider count is the cluster signal — single-name
    // routine accumulation doesn't qualify.
    const byInsider = new Map(); // key -> { name, weightedDollars }
    for (const q of qualifying) {
      const entry = byInsider.get(q.key) || { name: q.name, weightedDollars: 0 };
      entry.weightedDollars += roleWeight(q.role) * q.dollars;
      // Keep the first canonical spelling we saw; subsequent variants
      // collapse to the same bucket but don't rename it.
      if (!entry.name) entry.name = q.name;
      byInsider.set(q.key, entry);
    }
    if (byInsider.size < CLUSTER_THRESHOLD) {
      cache.set(sym, { at: Date.now(), payload: null });
      return null;
    }

    // Composite score: Σ(weight × $) across every qualifying P leg.
    // totalDollars is the unweighted leg sum — useful for the panel
    // and the brief alongside the weighted score.
    let score = 0;
    let totalDollars = 0;
    let latestTs = -Infinity;
    let latestLeg = null;
    for (const q of qualifying) {
      score += roleWeight(q.role) * q.dollars;
      totalDollars += q.dollars;
      if (q.ts > latestTs) {
        latestTs = q.ts;
        latestLeg = q;
      }
    }

    // Top insider: largest sum of role-weighted dollars across all
    // legs they reported. Ties — vanishingly rare with continuous
    // dollar values — resolve in iteration order, which is fine for
    // a display label.
    let topInsider = null;
    let topWeighted = -Infinity;
    for (const [, v] of byInsider) {
      if (v.weightedDollars > topWeighted) {
        topWeighted = v.weightedDollars;
        topInsider = v.name;
      }
    }

    // Into-weakness flag: the most-recent qualifying leg's price ≤
    // 90% of the 90d high. A null high (no price data, fetch failure,
    // ETF without OHLC) surfaces as `intoWeakness: null` — the
    // honest unknown rather than silently false.
    let intoWeakness = null;
    let high = null;
    try {
      high = await get90dHigh(sym);
    } catch {
      high = null;
    }
    if (Number.isFinite(high) && high > 0 && latestLeg) {
      intoWeakness = latestLeg.price <= high * INTO_WEAKNESS_PCT;
    }

    result = {
      ticker: sym,
      insiderCount: byInsider.size,
      totalDollars,
      score,
      intoWeakness,
      periodDays: WINDOW_DAYS,
      latestBuyAt: latestLeg ? latestLeg.date : null,
      topInsider,
    };
  } catch (err) {
    console.warn(`insiderClusters(${sym}) degraded:`, err.message);
    result = null;
  }

  cache.set(sym, { at: Date.now(), payload: result });
  return result;
}

// scanUniverse — fan getTickerCluster across a list of tickers, drop
// nulls, return the ranked candidates. Concurrency-bounded so a 25-
// ticker book doesn't fan out into 25 simultaneous Finnhub calls;
// each chunk's allSettled also means a single failing ticker can't
// trip the whole scan. Per-ticker errors are absorbed by
// getTickerCluster's own never-throws contract.
export async function scanUniverse(tickers, deps = {}) {
  if (!Array.isArray(tickers) || tickers.length === 0) return [];
  const list = tickers
    .map((t) => String(t || '').trim().toUpperCase())
    .filter(Boolean);

  const out = [];
  try {
    for (let i = 0; i < list.length; i += SCAN_CONCURRENCY) {
      const chunk = list.slice(i, i + SCAN_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((t) => getTickerCluster(t, deps))
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) out.push(s.value);
      }
    }
  } catch (err) {
    console.warn('scanUniverse degraded:', err.message);
  }

  // Default sort = score desc. Ties: into-weakness=true first, then
  // latestBuyAt desc (the more recent cluster wins). Compare against
  // the missing-data tier (null) by treating null as ineligible to
  // win the tie.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aw = a.intoWeakness === true ? 1 : 0;
    const bw = b.intoWeakness === true ? 1 : 0;
    if (bw !== aw) return bw - aw;
    return tsOf(b.latestBuyAt) - tsOf(a.latestBuyAt);
  });
  return out;
}
