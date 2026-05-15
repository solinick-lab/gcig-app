import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// MOVR — the fund's own book ranked by today's move, read live from
// the positions sheet (the same source as the dashboard), not the
// tickers people happened to chart in the terminal. No ticker input.
// Mirrors DES/CN: fetch, then hand the list to the shared /annotate
// AI brief.

const fmt = {
  px: (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(2)),
  pct: (v) =>
    v == null || Number.isNaN(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`,
  wt: (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(1)}%`),
  usd: (v) => {
    if (v == null || Number.isNaN(v)) return '—';
    const n = Number(v);
    return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  },
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
      .get('/terminal/movers', { params: { limit: 10 } })
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
    if (!data || (!data.gainers?.length && !data.losers?.length)) return;
    let cancelled = false;
    setBriefLoading(true);
    const line = (m) =>
      `${m.ticker} ${fmt.pct(m.changePct)} (${fmt.usd(m.dayUsd)}, ${fmt.wt(m.weight)} wt)`;
    const context = [
      `GCIG portfolio, as of ${data.asOf || 'n/a'} — ${data.ranked}/${data.universe} holdings moved`,
      `Gainers: ${data.gainers.map(line).join(', ') || 'none'}`,
      `Losers: ${data.losers.map(line).join(', ') || 'none'}`,
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
        <div className="term-loading">Loading portfolio movers…</div>
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

  const empty = !data.gainers?.length && !data.losers?.length;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">MOVR</span>
        <span className="name">
          Portfolio{data.asOf ? ` · as of ${data.asOf}` : ''}
          {data.universe ? ` · ${data.ranked}/${data.universe} holdings` : ''}
        </span>
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {empty ? (
        <div className="term-loading">
          No daily moves on the book yet — the positions sheet returned no
          non-cash holdings with a day change.
        </div>
      ) : (
        <div className="term-movers">
          <MoversTable title="▲ GAINERS" rows={data.gainers} dir="pos" />
          <MoversTable title="▼ LOSERS" rows={data.losers} dir="neg" />
        </div>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        GCIG holdings · daily change, live from the positions sheet. Cash
        excluded.
      </div>
    </div>
  );
}

function MoversTable({ title, rows, dir }) {
  return (
    <div className="term-movers-col">
      <div className="term-movers-title">{title}</div>
      {rows.length === 0 ? (
        <div className="term-loading">None.</div>
      ) : (
        <table className="term-table">
          <thead>
            <tr>
              <th style={{ width: 22 }}>#</th>
              <th>Ticker</th>
              <th className="num">Last</th>
              <th className="num">Wt</th>
              <th className="num">Day $</th>
              <th className="num">Day %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={m.ticker}>
                <td className="rank">{i + 1}</td>
                <td className="sym" title={m.name}>{m.ticker}</td>
                <td className="num">{fmt.px(m.last)}</td>
                <td className="num">{fmt.wt(m.weight)}</td>
                <td className={`num ${dir}`}>{fmt.usd(m.dayUsd)}</td>
                <td className={`num ${dir}`}>{fmt.pct(m.changePct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
