import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// CON — a ticker's analyst recommendation breakdown (the latest
// period's strong-buy → strong-sell counts) plus a compact trend of
// the recent periods, off the same Finnhub /stock/recommendation feed
// Peers consumes. Requires a ticker. Mirrors EARN/FIL/INSDR: fetch,
// render the breakdown + a term-table trend, then hand the loaded data
// to the shared /annotate AI brief — but skip the brief entirely when
// there is no coverage to read (confab-safe).

// Recommendation periods arrive as bare ISO days (YYYY-MM-DD). Parsing
// that straight through Date() reads it as UTC midnight, which slips a
// day back in any timezone west of UTC; pinning T00:00:00 (local)
// keeps the month the panel shows the month Finnhub meant. Same guard
// the sibling EARN/FIL panels use.
function parseISODay(s) {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
// Recommendation rows are monthly snapshots, so a "MMM 'YY" label
// reads better than a day-precise date the vendor doesn't really mean.
const fmtPeriod = (s) => {
  const d = parseISODay(s);
  return d
    ? d.toLocaleDateString('en', { month: 'short', year: '2-digit' })
    : '—';
};

// One distribution row → its parts, in display order, with the colour
// side each bucket sits on. Greens for the buy side, reds for the
// sell side, the dim neutral for holds — the same positive/negative
// vocabulary the other terminal panels use.
function tallyParts(row) {
  return [
    { key: 'strongBuy', label: 'Strong Buy', n: row.strongBuy || 0, side: 'pos' },
    { key: 'buy', label: 'Buy', n: row.buy || 0, side: 'pos' },
    { key: 'hold', label: 'Hold', n: row.hold || 0, side: 'mid' },
    { key: 'sell', label: 'Sell', n: row.sell || 0, side: 'neg' },
    { key: 'strongSell', label: 'Strong Sell', n: row.strongSell || 0, side: 'neg' },
  ];
}
const sideColor = {
  pos: 'var(--term-positive)',
  mid: 'var(--term-fg-dim)',
  neg: 'var(--term-negative)',
};
const rowTotal = (r) =>
  (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0);

export default function Consensus({ ticker }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setBrief('');
    api
      .get(`/terminal/consensus/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (!cancelled) setData(data);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  // Confab-safe: with neither a latest breakdown nor any trend rows
  // there is nothing for the model to ground on, so we never call
  // /annotate — an honest "no analyst coverage" line stands instead of
  // an invented read. Mirrors the empty-data guards on EARN/FIL.
  useEffect(() => {
    if (!data || !ticker) return;
    const latest = data.latest || null;
    const trend = Array.isArray(data.trend) ? data.trend : [];
    if (!latest && trend.length === 0) return;
    let cancelled = false;
    setBriefLoading(true);
    const lines = [];
    if (latest) {
      const t = rowTotal(latest);
      lines.push(
        `Latest period ${fmtPeriod(latest.period)} (${t} analyst${t === 1 ? '' : 's'}): ` +
          `Strong Buy ${latest.strongBuy || 0}, Buy ${latest.buy || 0}, ` +
          `Hold ${latest.hold || 0}, Sell ${latest.sell || 0}, ` +
          `Strong Sell ${latest.strongSell || 0}`
      );
    }
    if (trend.length) {
      lines.push('Recent trend (newest first):');
      trend.forEach((r) => {
        lines.push(
          `${fmtPeriod(r.period)}: SB ${r.strongBuy || 0} / B ${r.buy || 0} / ` +
            `H ${r.hold || 0} / S ${r.sell || 0} / SS ${r.strongSell || 0}`
        );
      });
    }
    api
      .post('/terminal/annotate', {
        ticker,
        function: 'CON',
        context: lines.join('\n'),
      })
      .then(({ data }) => {
        if (!cancelled) setBrief(data.brief || '');
      })
      .catch(() => {
        if (!cancelled) setBrief('');
      })
      .finally(() => {
        if (!cancelled) setBriefLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [data, ticker]);

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load analyst consensus.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading consensus for {ticker.toUpperCase()}…</div>
      </div>
    );
  }
  if (err) {
    return (
      <div className="term-panel">
        <div className="term-error">Error: {err}</div>
      </div>
    );
  }
  if (!data) return null;

  const latest = data.latest || null;
  const trend = Array.isArray(data.trend) ? data.trend : [];
  const hasData = !!latest || trend.length > 0;
  const parts = latest ? tallyParts(latest) : [];
  const total = latest ? rowTotal(latest) : 0;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{(data.ticker || ticker).toUpperCase()}</span>
        <span className="name">Analyst Consensus</span>
      </div>

      {!hasData ? (
        <div className="term-loading">
          No analyst coverage for {(data.ticker || ticker).toUpperCase()} —
          common for ETFs, funds, and thinly-covered names.
        </div>
      ) : (
        <>
          {latest ? (
            <div
              style={{
                border: '1px solid var(--term-border)',
                padding: '10px 12px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    color: 'var(--term-fg-dim)',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Latest Breakdown
                </span>
                <span style={{ color: 'var(--term-fg-muted)', fontSize: 12 }}>
                  {fmtPeriod(latest.period)}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 12 }}>
                  <span style={{ color: 'var(--term-fg-dim)' }}>{total} </span>
                  <span style={{ color: 'var(--term-fg-muted)' }}>
                    analyst{total === 1 ? '' : 's'}
                  </span>
                </span>
              </div>

              {/* Proportion bar — each bucket's share of the total,
                  buy side green, holds neutral, sell side red. A zero
                  bucket simply contributes no width. */}
              <div
                style={{
                  display: 'flex',
                  height: 8,
                  width: '100%',
                  border: '1px solid var(--term-border)',
                  overflow: 'hidden',
                  marginBottom: 10,
                }}
              >
                {total > 0 ? (
                  parts.map((p) =>
                    p.n > 0 ? (
                      <div
                        key={p.key}
                        title={`${p.label}: ${p.n}`}
                        style={{
                          width: `${(p.n / total) * 100}%`,
                          background: sideColor[p.side],
                          opacity: p.side === 'mid' ? 0.5 : 0.85,
                        }}
                      />
                    ) : null
                  )
                ) : null}
              </div>

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px 18px',
                }}
              >
                {parts.map((p) => {
                  const pct = total > 0 ? Math.round((p.n / total) * 100) : 0;
                  return (
                    <span
                      key={p.key}
                      style={{
                        fontSize: 12,
                        display: 'inline-flex',
                        alignItems: 'baseline',
                        gap: 6,
                      }}
                    >
                      <span style={{ color: 'var(--term-fg-dim)' }}>{p.label}</span>
                      <span
                        style={{
                          color: sideColor[p.side],
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {p.n}
                      </span>
                      <span style={{ color: 'var(--term-fg-muted)' }}>
                        ({pct}%)
                      </span>
                    </span>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="term-loading">
              No latest-period breakdown on file.
            </div>
          )}

          <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
            <span className="label">◢ AI BRIEF</span>
            {briefLoading ? 'Generating…' : brief || 'No brief available.'}
          </div>

          {trend.length === 0 ? (
            <div className="term-loading">No recommendation history on file.</div>
          ) : (
            <table className="term-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Strong Buy</th>
                  <th className="num">Buy</th>
                  <th className="num">Hold</th>
                  <th className="num">Sell</th>
                  <th className="num">Strong Sell</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((r, i) => (
                  <tr key={`${r.period}-${i}`}>
                    <td className="sym">{fmtPeriod(r.period)}</td>
                    <td className="num pos">{r.strongBuy || 0}</td>
                    <td className="num pos">{r.buy || 0}</td>
                    <td className="num">{r.hold || 0}</td>
                    <td className="num neg">{r.sell || 0}</td>
                    <td className="num neg">{r.strongSell || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Finnhub analyst recommendation trend · newest first · 24h cache.
        Greens are the buy side, reds the sell side.
      </div>
    </div>
  );
}
