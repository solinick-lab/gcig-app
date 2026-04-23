#!/usr/bin/env node
// Pull daily closes for a ticker (default VOO) from a start date
// (default 2025-10-17) through today, carrying Friday's close forward
// through weekends / holidays so every calendar day has a value. Emits
// CSV to stdout (default) or JSON with --format json.
//
// Uses Yahoo's public v8/finance/chart endpoint — same pattern
// server/src/routes/holdings.js uses for live quotes. No external
// deps, but Yahoo aggressively rate-limits shared IPs: if you hit
// 429s, wait 5-10 minutes and retry. Running from your own machine
// (not a VPN / cloud IP) tends to work first try.
//
// Usage:
//   node server/scripts/pull-voo.js
//   node server/scripts/pull-voo.js > voo.csv
//   node server/scripts/pull-voo.js --ticker SPY --start 2025-01-01
//   node server/scripts/pull-voo.js --format json > voo.json
//
// Output CSV columns: date, close, source
//   source = 'close' on trading days, 'carry-forward' on weekends/holidays.

const args = process.argv.slice(2);

function getArg(name, fallback) {
  const i = args.findIndex((a) => a === `--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`pull-voo.js — daily benchmark puller

Usage:
  node server/scripts/pull-voo.js [--ticker VOO] [--start 2025-10-17] [--format csv|json]

Flags:
  --ticker TICKER       Symbol to pull (default VOO)
  --start  YYYY-MM-DD   Start date, inclusive (default 2025-10-17)
  --format csv|json     Output format (default csv)
  --help, -h            Show this help

Output goes to stdout; run summary to stderr.
`);
  process.exit(0);
}

const ticker = String(getArg('ticker', 'VOO')).toUpperCase();
const startStr = String(getArg('start', '2025-10-17'));
const format = String(getArg('format', 'csv')).toLowerCase();

const start = new Date(`${startStr}T00:00:00Z`);
if (Number.isNaN(start.getTime())) {
  console.error(`Invalid --start: "${startStr}". Use YYYY-MM-DD.`);
  process.exit(1);
}
if (!['csv', 'json'].includes(format)) {
  console.error(`Invalid --format: "${format}". Use csv or json.`);
  process.exit(1);
}

const end = new Date();
end.setUTCHours(23, 59, 59, 999);

const period1 = Math.floor(start.getTime() / 1000);
const period2 = Math.floor(end.getTime() / 1000);
const url =
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
  `?period1=${period1}&period2=${period2}&interval=1d`;

// Match the UA server/src/routes/holdings.js uses so we stay consistent
// with the live-quote path. Yahoo occasionally rejects non-browser UAs.
const YF_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// 429 and 5xx are worth retrying; anything else won't get better.
// Three attempts at 0 / 2s / 6s keeps total latency reasonable.
async function fetchJson() {
  const backoffMs = [0, 2000, 6000];
  let lastErr = '';
  for (let i = 0; i < backoffMs.length; i++) {
    if (backoffMs[i]) await new Promise((r) => setTimeout(r, backoffMs[i]));
    try {
      const res = await fetch(url, { headers: YF_HEADERS });
      if (res.ok) return res.json();
      lastErr = `Yahoo ${res.status} ${res.statusText}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      lastErr = `fetch failed: ${err.message}`;
    }
  }
  throw new Error(lastErr || 'unknown fetch error');
}

let json;
try {
  json = await fetchJson();
} catch (err) {
  console.error(err.message);
  if (err.message.includes('429')) {
    console.error(
      'Yahoo is rate-limiting this IP. Wait 5-10 minutes and try again, ' +
        'or run from a different machine.'
    );
  }
  process.exit(2);
}

const result = json?.chart?.result?.[0];
if (!result) {
  const msg = json?.chart?.error?.description || 'Unexpected response shape';
  console.error(`No data returned for ${ticker}: ${msg}`);
  process.exit(3);
}

const timestamps = result.timestamp || [];
const closes = result.indicators?.quote?.[0]?.close || [];
const adjcloses = result.indicators?.adjclose?.[0]?.adjclose || [];

// Prefer adjusted close (dividend + split-adjusted) — that's the right
// series for a total-return benchmark comparison. Fall back to raw
// close if adjclose is absent.
function pick(i) {
  if (adjcloses[i] != null) return adjcloses[i];
  if (closes[i] != null) return closes[i];
  return null;
}

// Build Map<YYYY-MM-DD (UTC), close> of trading-day values.
const byDate = new Map();
for (let i = 0; i < timestamps.length; i++) {
  const val = pick(i);
  if (val == null) continue;
  const d = new Date(timestamps[i] * 1000);
  const key = d.toISOString().slice(0, 10);
  byDate.set(key, val);
}

// Iterate every calendar day from start to today (UTC). When a date
// has no trading value, carry the most recent prior close forward so
// weekend/holiday rows line up with a day-by-day portfolio tracker.
const rows = [];
const cursor = new Date(start);
cursor.setUTCHours(0, 0, 0, 0);
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

let lastClose = null;
while (cursor <= today) {
  const key = cursor.toISOString().slice(0, 10);
  const close = byDate.get(key);
  if (close != null) {
    lastClose = close;
    rows.push({ date: key, close, source: 'close' });
  } else if (lastClose != null) {
    rows.push({ date: key, close: lastClose, source: 'carry-forward' });
  }
  // else: pre-first-trading-day (e.g. start is a Sunday) — skip.
  cursor.setUTCDate(cursor.getUTCDate() + 1);
}

if (format === 'json') {
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
} else {
  process.stdout.write('date,close,source\n');
  for (const r of rows) {
    process.stdout.write(`${r.date},${r.close.toFixed(4)},${r.source}\n`);
  }
}

const tradingDays = rows.filter((r) => r.source === 'close').length;
const carried = rows.length - tradingDays;
const first = rows[0];
const last = rows[rows.length - 1];
console.error(
  `[${ticker}] ${rows.length} rows (${tradingDays} trading days, ${carried} carry-forward) ` +
    `from ${first?.date} to ${last?.date} · last close $${last?.close.toFixed(2)} (Yahoo adjusted close)`
);
