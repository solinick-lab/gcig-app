import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// MOVR — every holding in the book and how much it's up or down today,
// read live from the positions sheet (the same source as the
// dashboard), not the tickers people charted in the terminal. One
// flat list, sorted best-to-worst. No ticker input. Mirrors DES/CN:
// fetch, then hand the list to the shared /annotate AI brief.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
};

export default function Movers() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setBrief('');
    api
      .get('/terminal/movers')
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
  }, []);

  useEffect(() => {
    if (!data?.rows?.length) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `GCIG portfolio, as of ${data.asOf || 'n/a'} — ${data.count} holdings, today's move:`,
      ...data.rows.map((m) => `${m.ticker} ${fmt.pct(m.changePct)}`),
    ].join('\n');
    api
      .post('/terminal/annotate', { function: 'MOVR', context })
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
  }, [data]);

  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading portfolio…</div>
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

  const rows = data.rows || [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">MOVR</span>
        <span className="name">
          Portfolio{data.asOf ? ` · as of ${data.asOf}` : ''}
          {data.count ? ` · ${data.count} holdings` : ''}
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {rows.length === 0 ? (
        <div className="term-loading">
          No daily moves on the book — the positions sheet returned no non-cash
          holdings with a day change.
        </div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 22 }}>#</th>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Day %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.ticker}>
                <td className="rank">{i + 1}</td>
                <td className="sym" title={m.name}>{m.ticker}</td>
                <td className="num">{fmt.px(m.last)}</td>
                <td className={`num ${m.changePct >= 0 ? 'pos' : 'neg'}`}>
                  {fmt.pct(m.changePct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        GCIG holdings · today's move, live from the positions sheet. Cash
        excluded.
      </div>
    </div>
  );
}
