// Finnhub market-data fetchers beyond plain news + quotes. Free tier
// allows both /calendar/earnings and /stock/recommendation at 60 rpm,
// so both are safe to pull on every dashboard / holding-detail load
// with sensible caching.

const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const DEFAULT_TIMEOUT_MS = 8_000;

// In-memory caches. Earnings rarely change intra-day; recommendation
// trends update roughly weekly. Long TTLs keep the Finnhub budget
// nowhere near the 60 rpm cap even with heavy dashboard use.
const EARNINGS_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const CONSENSUS_TTL_MS = 24 * 60 * 60 * 1000; // 24h

const earningsCache = new Map(); // ticker → { at, data }
const consensusCache = new Map(); // ticker → { at, data }

// Peer sets barely move; quote-level snapshots want intraday-ish
// freshness. A PEER load is focus + N peers, so the 15m snapshot
// cache keeps repeated loads (and overlap with DES) off the budget.
const PEERS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SNAPSHOT_TTL_MS = 15 * 60 * 1000; // 15m
const peersCache = new Map(); // ticker → { at, data: string[] }
const snapshotCache = new Map(); // ticker → { at, data }

async function finnhubFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`finnhub responded ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Earnings calendar for a single ticker, windowed daysAhead into the
// future (default 60). Returns the upcoming earnings row from Finnhub
// or null if nothing is scheduled / the ticker doesn't have consensus
// coverage (ETFs, illiquid names).
//
// Finnhub response shape: { earningsCalendar: [{ date, epsEstimate,
//   epsActual, hour: 'bmo'|'amc'|'dmh', quarter, year, symbol,
//   revenueEstimate, revenueActual }, ...] }. `hour` is 'bmo' = before
// market open, 'amc' = after market close, 'dmh' = during market hours.
export async function getUpcomingEarnings(ticker, { daysAhead = 60 } = {}) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return null;
  const upper = String(ticker).toUpperCase();

  const cached = earningsCache.get(upper);
  if (cached && Date.now() - cached.at < EARNINGS_TTL_MS) {
    return cached.data;
  }

  const now = new Date();
  const from = fmtDate(now);
  const to = fmtDate(new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000));
  const url =
    `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}` +
    `&symbol=${encodeURIComponent(upper)}&token=${encodeURIComponent(key)}`;

  let data = null;
  try {
    const json = await finnhubFetch(url);
    const rows = Array.isArray(json?.earningsCalendar) ? json.earningsCalendar : [];
    // Pick the soonest row at/after today. The endpoint can return
    // past-reported quarters when the window straddles a release.
    const today = fmtDate(now);
    const upcoming = rows
      .filter((r) => r && r.date && r.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    data = upcoming[0] || null;
  } catch (err) {
    console.warn(`earnings(${upper}) failed:`, err.message);
    data = null;
  }
  earningsCache.set(upper, { at: Date.now(), data });
  return data;
}

// Batch helper for dashboards / AI briefs. Runs per-ticker in parallel
// (each call respects its own 12h cache, so a cold fetch happens at
// most every 12 hours per ticker).
export async function getUpcomingEarningsBatch(tickers, opts = {}) {
  const list = Array.from(new Set((tickers || []).filter(Boolean).map((t) =>
    String(t).toUpperCase()
  )));
  const rows = await Promise.all(list.map((t) => getUpcomingEarnings(t, opts)));
  const out = {};
  list.forEach((t, i) => {
    if (rows[i]) out[t] = rows[i];
  });
  return out;
}

// Period label for an earnings row. Finnhub usually carries `quarter`
// (1-4) and `year`; when it doesn't (it's inconsistent on the free
// tier) we fall back to deriving a calendar quarter from the report
// date so the panel never shows a bare blank where a label belongs.
function earningsPeriod(row) {
  if (row?.quarter && row?.year) return `Q${row.quarter} ${row.year}`;
  if (row?.year) return String(row.year);
  if (row?.date) {
    const d = new Date(`${row.date}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      const q = Math.floor(d.getUTCMonth() / 3) + 1;
      return `Q${q} ${d.getUTCFullYear()}`;
    }
  }
  return '—';
}

// The EARN panel's view of the same Finnhub /calendar/earnings feed
// getUpcomingEarnings already taps — one widened window (≈13 months
// back through ≈90 days ahead) instead of the forward-only slice, so a
// single call yields both the next scheduled report and the trailing
// beat/miss record. Reuses finnhubFetch, fmtDate and the shared
// earningsCache/TTL wholesale; the cache key is namespaced ('earn:')
// so the widened payload and getUpcomingEarnings' narrow single-row
// payload share the Map and its 12h TTL without clobbering each
// other's differently-shaped value.
//
// Returns { upcoming, history }: `upcoming` is the soonest row dated
// today-or-later that still carries an estimate (null when nothing is
// on the calendar — ETFs, illiquid names, no consensus coverage);
// `history` is past rows that actually reported (have epsActual),
// newest-first and capped at 12, each with a surprise % computed off
// the estimate (null when the estimate is missing or zero, so a
// divide-by-zero or a meaningless surprise never reaches the UI).
// Never throws — a miss or any error degrades to { upcoming:null,
// history:[] } exactly like its sibling.
export async function getEarnings(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return { upcoming: null, history: [] };
  const upper = String(ticker).toUpperCase();

  const cacheKey = `earn:${upper}`;
  const cached = earningsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EARNINGS_TTL_MS) {
    return cached.data;
  }

  const now = new Date();
  // ≈13 months back catches the last four-or-five reported quarters
  // even when a release just slipped a few days; ≈90 days ahead is the
  // same forward horizon a fiscal-quarter cadence needs to surface the
  // next scheduled date.
  const from = fmtDate(new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000));
  const to = fmtDate(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000));
  const url =
    `${FINNHUB_BASE}/calendar/earnings?from=${from}&to=${to}` +
    `&symbol=${encodeURIComponent(upper)}&token=${encodeURIComponent(key)}`;

  let data = { upcoming: null, history: [] };
  try {
    const json = await finnhubFetch(url);
    const rows = Array.isArray(json?.earningsCalendar) ? json.earningsCalendar : [];
    const today = fmtDate(now);

    // Next report: the soonest future-dated row that still has an
    // estimate. A future row with no estimate yet is not actionable —
    // treat it as nothing scheduled rather than show a date with a
    // blank number.
    const upcomingRow = rows
      .filter((r) => r && r.date && r.date >= today && r.epsEstimate != null)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;

    // History: rows that have actually reported (epsActual present),
    // strictly in the past, newest-first, capped at 12 quarters.
    const history = rows
      .filter((r) => r && r.date && r.date < today && r.epsActual != null)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 12)
      .map((r) => {
        const est = r.epsEstimate;
        const act = r.epsActual;
        // Surprise is only meaningful with a non-zero estimate;
        // |est| in the denominator keeps the sign coming from the
        // beat/miss, not from a negative-EPS base.
        const surprisePct =
          est != null && act != null && est !== 0
            ? ((act - est) / Math.abs(est)) * 100
            : null;
        return {
          period: earningsPeriod(r),
          date: r.date,
          epsEstimate: est ?? null,
          epsActual: act ?? null,
          surprisePct,
        };
      });

    data = {
      upcoming: upcomingRow
        ? { date: upcomingRow.date, epsEstimate: upcomingRow.epsEstimate ?? null }
        : null,
      history,
    };
  } catch (err) {
    console.warn(`getEarnings(${upper}) failed:`, err.message);
    data = { upcoming: null, history: [] };
  }
  earningsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

// Analyst recommendation trend. Finnhub returns the most recent few
// months as separate rows. We keep the latest, plus a 3-month-ago
// row if one exists, so callers can show "current + delta".
//
// Row shape: { period (YYYY-MM-DD), strongBuy, buy, hold, sell,
//   strongSell, symbol }.
export async function getAnalystConsensus(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return null;
  const upper = String(ticker).toUpperCase();

  const cached = consensusCache.get(upper);
  if (cached && Date.now() - cached.at < CONSENSUS_TTL_MS) {
    return cached.data;
  }

  const url =
    `${FINNHUB_BASE}/stock/recommendation?symbol=${encodeURIComponent(upper)}` +
    `&token=${encodeURIComponent(key)}`;

  let data = null;
  try {
    const json = await finnhubFetch(url);
    if (Array.isArray(json) && json.length > 0) {
      const sorted = [...json].sort((a, b) => (b.period || '').localeCompare(a.period || ''));
      const latest = sorted[0];
      // Find a row ~90 days older than latest to form a trend delta.
      const latestDate = new Date(latest.period);
      const threeMonthsAgo = new Date(latestDate.getTime() - 90 * 24 * 60 * 60 * 1000);
      const prior = sorted.find((r) => new Date(r.period) <= threeMonthsAgo) || null;

      const total = (x) =>
        (x.strongBuy || 0) + (x.buy || 0) + (x.hold || 0) + (x.sell || 0) + (x.strongSell || 0);
      const bullishShare = (x) => {
        const t = total(x);
        return t > 0 ? ((x.strongBuy || 0) + (x.buy || 0)) / t : null;
      };

      data = {
        ticker: upper,
        period: latest.period,
        strongBuy: latest.strongBuy || 0,
        buy: latest.buy || 0,
        hold: latest.hold || 0,
        sell: latest.sell || 0,
        strongSell: latest.strongSell || 0,
        total: total(latest),
        bullishShare: bullishShare(latest), // 0..1 or null
        prior: prior
          ? {
              period: prior.period,
              strongBuy: prior.strongBuy || 0,
              buy: prior.buy || 0,
              hold: prior.hold || 0,
              sell: prior.sell || 0,
              strongSell: prior.strongSell || 0,
              total: total(prior),
              bullishShare: bullishShare(prior),
            }
          : null,
      };
    }
  } catch (err) {
    console.warn(`consensus(${upper}) failed:`, err.message);
    data = null;
  }
  consensusCache.set(upper, { at: Date.now(), data });
  return data;
}

// Finnhub /stock/peers — companies it groups in the same sub-industry
// as the symbol. Free tier, 60 rpm; the set is stable, so a 24h cache
// keeps this off the budget. Returns an uppercased ticker array
// (Finnhub lists the symbol itself first); empty array on miss, which
// is normal for ETFs and thinly-covered names.
export async function getPeers(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return [];
  const upper = String(ticker).toUpperCase();

  const cached = peersCache.get(upper);
  if (cached && Date.now() - cached.at < PEERS_TTL_MS) return cached.data;

  const url =
    `${FINNHUB_BASE}/stock/peers?symbol=${encodeURIComponent(upper)}` +
    `&token=${encodeURIComponent(key)}`;

  let data = [];
  try {
    const json = await finnhubFetch(url);
    if (Array.isArray(json)) {
      data = json
        .map((t) => String(t || '').toUpperCase())
        .filter((t) => /^[A-Z0-9.\-]{1,10}$/.test(t));
    }
  } catch (err) {
    console.warn(`peers(${upper}) failed:`, err.message);
    data = [];
  }
  peersCache.set(upper, { at: Date.now(), data });
  return data;
}

// Compact one-ticker snapshot for the PEER grid — just the comparison
// columns. Same Finnhub call set as the holding-detail fetch (quote +
// profile2 + metric); profile/metric failures degrade to blanks
// rather than sinking the row. Null only if the quote itself is
// missing (unknown symbol). 15m cache shared across loads.
export async function getPeerSnapshot(ticker) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key || !ticker) return null;
  const upper = String(ticker).toUpperCase();

  const cached = snapshotCache.get(upper);
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.data;

  let data = null;
  try {
    const tok = encodeURIComponent(key);
    const sym = encodeURIComponent(upper);
    const [q, profile, metric] = await Promise.all([
      finnhubFetch(`${FINNHUB_BASE}/quote?symbol=${sym}&token=${tok}`),
      finnhubFetch(`${FINNHUB_BASE}/stock/profile2?symbol=${sym}&token=${tok}`).catch(() => ({})),
      finnhubFetch(`${FINNHUB_BASE}/stock/metric?symbol=${sym}&metric=all&token=${tok}`).catch(() => ({})),
    ]);
    // Finnhub returns c=0 for unknown symbols.
    if (q && q.c) {
      const m = metric?.metric || {};
      const prev = q.pc || null;
      data = {
        ticker: upper,
        name: profile?.name || upper,
        price: q.c,
        changePct: prev ? (q.c - prev) / prev : null,
        marketCap:
          profile?.marketCapitalization != null
            ? profile.marketCapitalization * 1e6
            : null,
        trailingPE: m.peBasicExclExtraTTM ?? m.peInclExtraTTM ?? null,
        forwardPE: m.peNormalizedAnnual ?? null,
        dividendYield:
          m.currentDividendYieldTTM != null ? m.currentDividendYieldTTM / 100 : null,
        beta: m.beta ?? null,
      };
    }
  } catch (err) {
    console.warn(`peerSnapshot(${upper}) failed:`, err.message);
    data = null;
  }
  snapshotCache.set(upper, { at: Date.now(), data });
  return data;
}
