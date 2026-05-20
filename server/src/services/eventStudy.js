import { getHistory as defaultGetHistory } from './priceHistory.js';

// Event-study primitive — the reusable math behind the WX panel and
// the macro factor-sensitivity sub-project that ships after it. Pure,
// deterministic, never-throws: feed it a list of dated events plus a
// basket of tickers and an injected getHistory, get back per-window
// aggregates (mean / median / std / n / t-stat) plus a flat per-event
// detail list.
//
// Returns are SPY-relative (sector-neutral): for every (event, ticker)
// the abnormal return is the ticker's forward N-day price change MINUS
// SPY's forward N-day price change over the same trading-day window,
// anchored independently on each series from the event date. Anchoring
// independently is load-bearing — the ticker and SPY don't share a
// non-trading-day calendar (different exchanges, foreign listings, the
// ETF's own halt history), so a shared bar index would silently bias
// the result. Independent anchoring keeps the math honest: if one side
// of the pair lacks a t0 or tN bar, that single observation is dropped
// and the aggregate is computed from the survivors.
//
// Windows are trading sessions, not calendar days: tN = t0 + N bars
// in the ticker's own series. Weekends, holidays, and any other gap
// in the cache are skipped naturally by the bar-index walk.

const WINDOWS = [1, 5, 20];
const CONCURRENCY = 6;

// Sample standard deviation (n-1 denominator). Returns 0 when n<2 — a
// single observation has no within-sample dispersion, and reporting a
// non-zero std on n=1 would invite a fake t-stat.
function sampleStd(xs, mean) {
  if (xs.length < 2) return 0;
  let sq = 0;
  for (const x of xs) {
    const d = x - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / (xs.length - 1));
}

// Median of a numeric list. Returns 0 for the empty case so the caller
// can short-circuit downstream display without a NaN sneak-in.
function median(xs) {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// First bar index whose ISO date is >= the event date. Returns -1 if
// no such bar exists (event is past the tail of the series).
function findT0Index(barsList, eventDate) {
  if (!Array.isArray(barsList)) return -1;
  for (let i = 0; i < barsList.length; i++) {
    const b = barsList[i];
    if (!b || !b.date) continue;
    if (b.date >= eventDate) return i;
  }
  return -1;
}

// Run all ticker fetches up front with a small concurrency cap so a
// large basket × SPY doesn't fan a single panel mount into a 30-way
// DB burst. Per-call cache so re-using the same ticker across baskets
// (XOM in two themes, e.g.) doesn't refetch.
async function fetchAll(tickers, getHistory) {
  const out = new Map();
  const queue = tickers.slice();
  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, queue.length); w++) {
    workers.push(
      (async () => {
        while (queue.length > 0) {
          const t = queue.shift();
          if (out.has(t)) continue;
          try {
            const r = await getHistory(t, '5y');
            // Normalize: getHistory may return either a bare array of
            // bars (the current priceHistory.js contract) or an object
            // with a `.bars` field (a future shape that would still be
            // valid). Both end up as a flat array here.
            const list = Array.isArray(r) ? r : Array.isArray(r?.bars) ? r.bars : null;
            out.set(t, list);
          } catch {
            out.set(t, null);
          }
        }
      })()
    );
  }
  await Promise.all(workers);
  return out;
}

// Build an empty aggregate of the right shape so callers can always
// destructure perWindow['5d'].n etc. without a guard.
function emptyAggregate() {
  const perWindow = {};
  for (const w of WINDOWS) {
    perWindow[`${w}d`] = { mean: 0, median: 0, std: 0, n: 0, tStat: 0 };
  }
  return { perWindow, perEvent: [] };
}

export async function runEventStudy(events, basket, deps = {}) {
  const getHistory = deps.getHistory || defaultGetHistory;
  if (!Array.isArray(events) || events.length === 0) return emptyAggregate();
  if (!Array.isArray(basket) || basket.length === 0) return emptyAggregate();

  // SPY is always part of the fetch list — it's the benchmark for the
  // abnormal-return subtraction.
  const tickers = Array.from(new Set([...basket.map((t) => String(t).toUpperCase()), 'SPY']));
  let priceMap;
  try {
    priceMap = await fetchAll(tickers, getHistory);
  } catch {
    return emptyAggregate();
  }

  const spyBars = priceMap.get('SPY');

  const perEvent = [];
  const buckets = new Map(); // window → number[] of abnormals

  for (const ev of events) {
    if (!ev || !ev.date) continue;
    // SPY anchor for this event — required for every observation, so
    // resolve it once per event.
    const spyT0 = findT0Index(spyBars, ev.date);

    for (const rawTicker of basket) {
      const ticker = String(rawTicker || '').toUpperCase();
      if (!ticker) continue;
      const tBars = priceMap.get(ticker);
      const tT0 = findT0Index(tBars, ev.date);
      if (tT0 === -1 || spyT0 === -1) continue;

      for (const w of WINDOWS) {
        const tTN = tT0 + w;
        const spyTN = spyT0 + w;
        if (tTN >= tBars.length) continue;
        if (spyTN >= spyBars.length) continue;
        const tT0Close = tBars[tT0]?.close;
        const tTNClose = tBars[tTN]?.close;
        const spyT0Close = spyBars[spyT0]?.close;
        const spyTNClose = spyBars[spyTN]?.close;
        if (
          !Number.isFinite(tT0Close) ||
          !Number.isFinite(tTNClose) ||
          !Number.isFinite(spyT0Close) ||
          !Number.isFinite(spyTNClose) ||
          tT0Close === 0 ||
          spyT0Close === 0
        ) {
          continue;
        }
        const tickerRet = tTNClose / tT0Close - 1;
        const spyRet = spyTNClose / spyT0Close - 1;
        const abnormal = tickerRet - spyRet;
        perEvent.push({
          event: ev.date,
          label: ev.label || null,
          ticker,
          window: w,
          tickerRet,
          spyRet,
          abnormal,
        });
        if (!buckets.has(w)) buckets.set(w, []);
        buckets.get(w).push(abnormal);
      }
    }
  }

  const perWindow = {};
  for (const w of WINDOWS) {
    const arr = buckets.get(w) || [];
    const n = arr.length;
    if (n === 0) {
      perWindow[`${w}d`] = { mean: 0, median: 0, std: 0, n: 0, tStat: 0 };
      continue;
    }
    const mean = arr.reduce((s, x) => s + x, 0) / n;
    const med = median(arr);
    const std = sampleStd(arr, mean);
    const tStat = std > 0 && n >= 2 ? mean / (std / Math.sqrt(n)) : 0;
    perWindow[`${w}d`] = { mean, median: med, std, n, tStat };
  }

  return { perWindow, perEvent };
}
