// Zillow Observed Rent Index (ZORI) feed.
//
// Why this matters: shelter is ~33% of CPI (the LARGEST single component).
// The BLS measures shelter via Owners' Equivalent Rent and tenant lease
// prices, both of which lag market rents by 6-12 months because they
// re-survey leases that were typically signed months ago. Zillow's ZORI
// uses asking rents on actively-listed units — it captures the marginal
// rent buyer's experience TODAY, leading BLS shelter by 6-12 months.
//
// Zillow Research publishes free CSVs at:
//   https://www.zillow.com/research/data/
// The national ZORI series filename has been stable as:
//   https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv
//
// CSV layout (Metro-level, "United States" is RegionID=102001 / RegionType=country):
//   RegionID,SizeRank,RegionName,RegionType,StateName,YYYY-MM-DD,YYYY-MM-DD,...
//   102001,0,United States,country,, 1234.5, 1245.6, ...
//
// We pull the United States row, parse the trailing date columns into a
// monthly time series, and compute YoY / MoM changes for the latest 36
// months. The Python nowcaster uses lag-0/6/12 of YoY to predict shelter.
//
// Cache: 6h. Zillow updates monthly, so 6h shields us from rate-limiting
// and reduces churn on Render.
//
// Fallback: if Zillow returns 404 / changes URL / parses badly, we fall
// back to FRED's CSUSHPISA (Case-Shiller National Home Price Index) as
// a (much weaker) proxy for housing momentum. Case-Shiller is monthly,
// freely available without an API key, and at least correlates with
// rental demand. We mark `usedFallback: true` and `source: 'case_shiller'`
// when this path is taken so the Python side knows to be honest about
// what it's actually using.

import https from 'node:https';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT_MS = 30_000;

// Pretend to be a normal browser. Zillow's CDN may return 403 to a
// generic UA.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Primary URL — Zillow's "smoothed, seasonally adjusted, all homes"
// national ZORI feed.
const ZORI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv';

// Zillow Home Value Index (ZHVI) — captures sale prices, leading indicator
// for housing wealth, mortgage payments, and ultimately rents themselves.
// Cap rate considerations: when home prices rise faster than rents,
// landlords push rents up to maintain yield. Same CSV layout as ZORI;
// same "United States" national row selection.
const ZHVI_URL =
  'https://files.zillowstatic.com/research/public_csvs/zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv';

// Fallback proxy: FRED's Case-Shiller National Home Price Index. This is
// served as a CSV without an API key from FRED's `fredgraph.csv` endpoint.
const CASE_SHILLER_URL =
  'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CSUSHPISA';

let cache = { at: 0, data: null };

// Generic CSV/text fetch with redirect support and a real-browser UA.
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const doGet = (target, hops) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = https.get(
        target,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'text/csv,text/plain,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            const loc = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, target).toString();
            return doGet(loc, hops + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} on ${target}`));
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve(buf));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`timeout fetching ${target}`));
      });
      req.on('error', reject);
    };
    doGet(url, 0);
  });
}

// Minimal CSV row splitter. The metro-level Zillow CSV DOES embed commas
// inside quoted fields (e.g. `"New York, NY"`), so we handle quoted fields.
// We strip CR to handle Windows line endings.
function splitCsvLine(line) {
  const s = line.replace(/\r$/, '');
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuotes && s[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Top-15 metros (BLS-weighted urban areas, by Zillow SizeRank). Keys are
// the labels we expose to clients; values are arrays of accepted matches
// against Zillow's RegionName column. Matching is case-insensitive and
// uses startsWith on the comma-prefixed metro name (e.g. "New York,").
const METRO_TARGETS = [
  { key: 'New York', match: ['new york,'] },
  { key: 'Los Angeles', match: ['los angeles,'] },
  { key: 'Chicago', match: ['chicago,'] },
  { key: 'Dallas', match: ['dallas,'] },
  { key: 'Houston', match: ['houston,'] },
  { key: 'Washington', match: ['washington,'] },
  { key: 'Philadelphia', match: ['philadelphia,'] },
  { key: 'Miami', match: ['miami,'] },
  { key: 'Atlanta', match: ['atlanta,'] },
  { key: 'Boston', match: ['boston,'] },
  { key: 'Phoenix', match: ['phoenix,'] },
  { key: 'San Francisco', match: ['san francisco,'] },
  { key: 'Riverside', match: ['riverside,'] },
  { key: 'Detroit', match: ['detroit,'] },
  { key: 'Seattle', match: ['seattle,'] },
];

// Parse a YYYY-MM-DD style header into a Date. Returns null if not a date.
function parseDateHeader(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-01`; // normalize to month-start
}

// Convert one CSV row's date columns into a sorted [{date, level}] series.
function rowToSeries(cols, dateIdx) {
  const out = [];
  for (const { i, date } of dateIdx) {
    const raw = cols[i];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    out.push({ date, level: n });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Parse Zillow's national CSV (works for both ZORI and ZHVI which share
// the same column layout: RegionID, SizeRank, RegionName, RegionType,
// StateName, then trailing month columns). Returns an array of {date, level}
// sorted ascending by date, or null if parsing fails.
function parseZillowNationalCsv(text) {
  const full = parseZillowFullCsv(text, /*wantMetros=*/false);
  if (!full || !full.national) return null;
  return full.national;
}

// Parse Zillow's metro-level CSV and return BOTH the national series and
// (optionally) a map of top-15 metro -> series. Returns null if header
// parse fails. Individual metros that fail to parse are simply omitted
// from the returned `metros` map.
function parseZillowFullCsv(text, wantMetros = true) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  // Find the index of the first date column. Zillow's metadata columns
  // come first (RegionID, SizeRank, RegionName, RegionType, StateName).
  const dateIdx = [];
  for (let i = 0; i < header.length; i++) {
    const d = parseDateHeader(header[i]);
    if (d) dateIdx.push({ i, date: d });
  }
  if (dateIdx.length < 13) return null;

  // Find column positions for RegionName / RegionType / SizeRank.
  let nameCol = -1;
  let typeCol = -1;
  let sizeRankCol = -1;
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (h === 'regionname') nameCol = i;
    else if (h === 'regiontype') typeCol = i;
    else if (h === 'sizerank') sizeRankCol = i;
  }
  if (nameCol < 0) return null;

  // Index target metros for fast lookup.
  const lowerToKey = new Map();
  if (wantMetros) {
    for (const t of METRO_TARGETS) {
      for (const m of t.match) lowerToKey.set(m, t.key);
    }
  }
  const remaining = wantMetros
    ? new Set(METRO_TARGETS.map((t) => t.key))
    : new Set();

  let usRow = null;
  const metroRows = new Map(); // key -> cols array

  for (let r = 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    if (cols.length < header.length) continue;
    const name = cols[nameCol] || '';
    const type = typeCol >= 0 ? cols[typeCol] : '';
    const rank = sizeRankCol >= 0 ? cols[sizeRankCol] : '';

    // Match national row.
    if (
      !usRow &&
      (name === 'United States' || type === 'country' || rank === '0')
    ) {
      usRow = cols;
    }

    // Match metro rows. Zillow names look like "New York, NY".
    if (wantMetros && remaining.size > 0) {
      const lowered = name.toLowerCase();
      for (const [prefix, key] of lowerToKey) {
        if (remaining.has(key) && lowered.startsWith(prefix)) {
          metroRows.set(key, cols);
          remaining.delete(key);
          break;
        }
      }
    }

    if (usRow && (!wantMetros || remaining.size === 0)) break;
  }
  if (!usRow) return null;

  const national = rowToSeries(usRow, dateIdx);
  const metros = {};
  if (wantMetros) {
    for (const [key, cols] of metroRows) {
      try {
        const s = rowToSeries(cols, dateIdx);
        if (s && s.length >= 13) metros[key] = s;
      } catch {
        // skip this metro on per-row failure; we keep what we have.
      }
    }
  }
  return { national, metros };
}

// Parse FRED's `fredgraph.csv` for a single series. Format:
//   DATE,VALUE
//   2024-01-01,310.123
//   2024-02-01,.
// `.` = no observation. Returns array of {date, level} sorted ascending.
function parseFredGraphCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  if (header.length < 2) return null;
  const out = [];
  for (let r = 1; r < lines.length; r++) {
    const cols = splitCsvLine(lines[r]);
    if (cols.length < 2) continue;
    const dateRaw = cols[0];
    const valRaw = cols[1];
    const m = dateRaw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) continue;
    if (valRaw === '.' || valRaw === '' || valRaw === undefined) continue;
    const n = Number(valRaw);
    if (!Number.isFinite(n)) continue;
    out.push({ date: `${m[1]}-${m[2]}-01`, level: n });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// Compute YoY / MoM percent changes and trim to the latest `n` months.
function annotateHistory(series, n) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const indexed = series.map((p, i) => ({ ...p, idx: i }));
  const out = [];
  for (let i = 0; i < indexed.length; i++) {
    const cur = indexed[i];
    const prevMo = indexed[i - 1];
    const prevYr = indexed[i - 12];
    const mom =
      prevMo && prevMo.level > 0
        ? ((cur.level / prevMo.level) - 1) * 100
        : null;
    const yoy =
      prevYr && prevYr.level > 0
        ? ((cur.level / prevYr.level) - 1) * 100
        : null;
    out.push({
      date: cur.date,
      level: Number(cur.level.toFixed(4)),
      yoy: yoy === null ? null : Number(yoy.toFixed(4)),
      mom: mom === null ? null : Number(mom.toFixed(4)),
    });
  }
  // Keep only the trailing n months — but we need yoy populated, so we
  // don't trim before computing YoY.
  return out.slice(-n);
}

// Fetch the Zillow Home Value Index (ZHVI) national series. Independent of
// the rent index: ZHVI scrape failures should NOT poison the rent response
// — they degrade gracefully to `zhvi: null` so the Python side can fall
// back to ZORI-only features.
async function fetchZhviHistory() {
  try {
    const raw = await fetchText(ZHVI_URL);
    const series = parseZillowNationalCsv(raw);
    if (!series || series.length < 13) {
      throw new Error(
        `ZHVI parse returned ${series ? series.length : 'null'} points`,
      );
    }
    return { history: annotateHistory(series, 60) };
  } catch (err) {
    console.warn('zillowFeed: ZHVI scrape failed —', err.message || err);
    return null;
  }
}

// Build the `metros` map (key -> {history}) from a parsed Zillow CSV.
// Wrapped to never throw — on any failure returns {}. This lets us add
// metro-level features without risking the national rent payload.
function buildMetrosBlock(parsed) {
  const out = {};
  if (!parsed || !parsed.metros || typeof parsed.metros !== 'object') return out;
  for (const [key, series] of Object.entries(parsed.metros)) {
    try {
      if (!Array.isArray(series) || series.length < 13) continue;
      out[key] = { history: annotateHistory(series, 36) };
    } catch {
      // skip metro on annotate failure
    }
  }
  return out;
}

// Public: returns
//   {
//     ok: true,
//     fetchedAt: ISO,
//     source: 'zillow_zori' | 'case_shiller',
//     usedFallback: bool,
//     history: [{date, level, yoy, mom}, ...]   // up to 36 months (national rent — backward-compat)
//     national: { history: [...] }              // same as `history`, namespaced
//     metros:   { "<Metro>": { history: [...] }, ... }   // top-15 metros (may be empty on fallback)
//     zhvi: { history: [{date, level, yoy, mom}, ...] } | null   // up to 60 months
//   }
// On total failure:
//   { ok: false, fetchedAt: ISO, source: null, usedFallback: false,
//     history: [], national: { history: [] }, metros: {}, zhvi: null, error: '...' }
export async function getZillowRent({ forceFresh = false } = {}) {
  if (!forceFresh && cache.data && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const fetchedAt = new Date().toISOString();
  let zoriErr = null;

  // Kick off ZHVI fetch in parallel — it's independent of ZORI/Case-Shiller.
  const zhviPromise = fetchZhviHistory();

  // 1) Try Zillow ZORI (metro-level CSV — gives us BOTH national + metros).
  try {
    const raw = await fetchText(ZORI_URL);
    let parsed = null;
    try {
      parsed = parseZillowFullCsv(raw, /*wantMetros=*/true);
    } catch (parseErr) {
      console.warn('zillowFeed: metro parse error —', parseErr.message || parseErr);
      parsed = null;
    }
    // If full parse failed, fall back to the national-only path so we
    // still get `history`.
    let nationalSeries;
    let metros = {};
    if (parsed && parsed.national && parsed.national.length >= 13) {
      nationalSeries = parsed.national;
      metros = buildMetrosBlock(parsed);
    } else {
      nationalSeries = parseZillowNationalCsv(raw);
      metros = {};
    }
    if (!nationalSeries || nationalSeries.length < 13) {
      throw new Error(
        `ZORI parse returned ${nationalSeries ? nationalSeries.length : 'null'} points`,
      );
    }
    const history = annotateHistory(nationalSeries, 36);
    const zhvi = await zhviPromise;
    const data = {
      ok: true,
      fetchedAt,
      source: 'zillow_zori',
      usedFallback: false,
      history,
      national: { history },
      metros,
      zhvi,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    zoriErr = err.message || String(err);
    console.warn('zillowFeed: ZORI scrape failed —', zoriErr);
  }

  // 2) Fallback: Case-Shiller via FRED CSV. Metros aren't available here.
  try {
    const raw = await fetchText(CASE_SHILLER_URL);
    const series = parseFredGraphCsv(raw);
    if (!series || series.length < 13) {
      throw new Error(
        `Case-Shiller parse returned ${series ? series.length : 'null'} points`,
      );
    }
    const history = annotateHistory(series, 36);
    const zhvi = await zhviPromise;
    const data = {
      ok: true,
      fetchedAt,
      source: 'case_shiller',
      usedFallback: true,
      history,
      national: { history },
      metros: {},
      zhvi,
      zoriError: zoriErr,
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    console.warn('zillowFeed: Case-Shiller fallback failed —', err.message);
    const zhvi = await zhviPromise;
    const data = {
      ok: false,
      fetchedAt,
      source: null,
      usedFallback: false,
      history: [],
      national: { history: [] },
      metros: {},
      zhvi,
      error: `zori: ${zoriErr || 'n/a'}; caseShiller: ${err.message}`,
    };
    // Cache the failure briefly so we recover quickly when the upstream
    // is back up.
    cache = { at: Date.now() - (CACHE_TTL_MS - 5 * 60 * 1000), data };
    return data;
  }
}
