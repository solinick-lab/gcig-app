import { parse } from 'csv-parse/sync';

// Pulls the club portfolio directly from a Google Sheet published as "Anyone with
// the link can view". Every fetch hits the CSV export URL, which forces Google
// Sheets to re-render GOOGLEFINANCE() formulas server-side — so the prices we
// receive are always live as of the moment of the fetch.

const SHEET_ID = process.env.GCIG_SHEET_ID;
const SHEET_GID = process.env.GCIG_SHEET_GID || '0';
const CACHE_TTL_MS = 60 * 1000;

let cached = null; // { at: number, data: ParsedPortfolio }

function csvUrl() {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
}

// Turn "$12,020.14", "16.93%", "  121 " into real numbers. Empty / dashes → null.
function toNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === '-' || s === '—' || s === '#N/A') return null;
  const cleaned = s.replace(/[$,%\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Map the sheet's header row to canonical field keys we care about.
// Anything we don't recognize is ignored.
const HEADER_ALIASES = {
  name: ['name', 'company', 'company name'],
  ticker: ['ticker', 'symbol'],
  sector: ['sector'],
  shares: ['shares owned', 'shares', 'quantity'],
  currentPrice: ['current price', 'price', 'last price'],
  avgCost: ['average purchase price', 'avg cost', 'average cost', 'cost basis'],
  marketValue: ['current market value', 'market value', 'value'],
  portfolioPct: ['% of portfolio', 'weight'],
  dayChange: ['day change', 'today', '1d'],
  dollarReturn: ['$ return', 'return', 'gain/loss $', 'gain'],
  ytdReturn: ['ytd return', 'ytd'],
  percentReturn: ['% return since purchase', 'total return %', 'return %'],
};

function matchHeaderIndex(headerRow) {
  const lower = headerRow.map((h) => String(h || '').trim().toLowerCase());
  const map = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const a of aliases) {
      const idx = lower.indexOf(a);
      if (idx !== -1) {
        map[key] = idx;
        break;
      }
    }
  }
  return map;
}

export async function getSheetPortfolio() {
  if (!SHEET_ID) {
    throw new Error('GCIG_SHEET_ID is not set in .env');
  }
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(csvUrl(), { redirect: 'follow' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Google Sheet fetch failed (${res.status}). Make sure the sheet is shared as "Anyone with the link can view". ${text.slice(0, 200)}`
    );
  }
  const csvText = await res.text();

  const rows = parse(csvText, {
    skip_empty_lines: false,
    relax_column_count: true,
  });

  // Find the header row — the first row containing a cell literally equal to "Ticker"
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => String(c).trim().toLowerCase() === 'ticker')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error('Could not find a "Ticker" header row in the sheet');
  }
  const colMap = matchHeaderIndex(rows[headerIdx]);
  if (colMap.ticker == null) {
    throw new Error('Sheet has no Ticker column');
  }

  const holdings = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];

    // Stop when we hit a "Total Portfolio Value:" row — anything after is summary/junk.
    const anyTotal = row.some((c) =>
      String(c || '').trim().toLowerCase().startsWith('total portfolio')
    );
    if (anyTotal) break;

    const rawTicker = String(row[colMap.ticker] || '').trim();
    const rawName = colMap.name != null ? String(row[colMap.name] || '').trim() : '';

    // Skip completely blank rows (keep scanning — cash may be below them).
    if (!rawTicker && !rawName) {
      const nonEmpty = row.some((c) => String(c || '').trim() !== '');
      if (!nonEmpty) continue;
      continue;
    }

    const isCash =
      /^cash/i.test(rawName) ||
      /cash/i.test(
        colMap.sector != null ? String(row[colMap.sector] || '') : ''
      );

    const marketValue = toNumber(row[colMap.marketValue]);
    let costBasis = toNumber(row[colMap.avgCost]);
    // Cash has no unrealized P/L — its cost basis equals its market value.
    if (isCash && costBasis == null && marketValue != null) {
      costBasis = marketValue;
    }

    const h = {
      ticker: rawTicker ? rawTicker.toUpperCase() : isCash ? 'CASH' : rawName.toUpperCase(),
      name: rawName || rawTicker,
      sector: colMap.sector != null ? String(row[colMap.sector] || '').trim() : null,
      shares: toNumber(row[colMap.shares]),
      price: toNumber(row[colMap.currentPrice]),
      costBasis,
      marketValue,
      portfolioPct: toNumber(row[colMap.portfolioPct]),
      dayChange: toNumber(row[colMap.dayChange]),
      dollarReturn: toNumber(row[colMap.dollarReturn]),
      ytdReturn: toNumber(row[colMap.ytdReturn]),
      percentReturn: toNumber(row[colMap.percentReturn]),
      isCash,
    };
    holdings.push(h);
  }

  // Compute totals. Prefer values already in the sheet when present, otherwise
  // derive from shares × price and shares × costBasis. For cash, cost = value.
  let totalValue = 0;
  let totalCost = 0;
  for (const h of holdings) {
    const mv =
      h.marketValue != null
        ? h.marketValue
        : h.shares != null && h.price != null
        ? h.shares * h.price
        : 0;
    let cost = 0;
    if (h.isCash) {
      cost = mv; // cash has zero unrealized P/L
    } else if (h.shares != null && h.costBasis != null) {
      cost = h.shares * h.costBasis;
    }
    totalValue += mv;
    totalCost += cost;
  }
  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0;

  const data = {
    holdings,
    totals: { totalValue, totalCost, totalGainLoss, totalGainLossPct },
    fetchedAt: new Date().toISOString(),
  };
  cached = { at: Date.now(), data };
  return data;
}
