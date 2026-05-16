// INSDR data — insider Form 4 activity. Finnhub is the primary feed
// (structured, already wired); SEC EDGAR Form 4 XML is the fallback so
// a missing/throttled Finnhub ticker still resolves. Best-effort and
// never throws — same contract as services/worldIndices.js.

// Form 4 transaction codes: only open-market Purchase / Sale carry the
// signal we plot. Everything else (M exercise, A grant, F tax, G gift,
// …) is fetched and tabled but never charted.
export function classifyCode(code) {
  const c = String(code || '').toUpperCase();
  return { isBuy: c === 'P', isSell: c === 'S' };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Finnhub /stock/insider-transactions rows: { name, transactionDate,
// filingDate, transactionCode, change (signed share delta),
// transactionPrice }. No relationship block, so role is null here.
export function normalizeFinnhub(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      const code = String(r?.transactionCode || '').toUpperCase();
      const { isBuy, isSell } = classifyCode(code);
      const shares = r?.change == null ? null : Math.abs(num(r.change));
      const price = num(r?.transactionPrice) || null;
      const value = shares != null && price ? shares * price : null;
      return {
        date: r?.transactionDate || r?.filingDate || null,
        name: r?.name || 'Unknown',
        role: null,
        code,
        isBuy,
        isSell,
        shares,
        price,
        value,
      };
    })
    .filter((t) => t.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}
