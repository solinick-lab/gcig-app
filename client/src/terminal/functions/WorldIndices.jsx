import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// WEI — world equity indices. No ticker; the basket is fixed server-side
// (GET /api/terminal/indices) and grouped by region. Same shape as the
// other panels: load data, then ask the AI layer for a one-paragraph
// read of the tape.

const fmt = {
  level: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : Number(v).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
  chg: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}`,
  pct: (v) =>
    v == null || Number.isNaN(v)
      ? '—'
      : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
};

export default function WorldIndices() {
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
      .get('/terminal/indices')
      .then(({ data: payload }) => {
        if (!cancelled) setData(payload);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e.response?.data?.error || e.message || 'Failed to load');
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
    const context = data.rows
      .map(
        (r) =>
          `${r.name} (${r.symbol}): ${fmt.level(r.last)} ${fmt.chg(r.change)} ${fmt.pct(r.changePercent)}`
      )
      .join('\n');
    api
      .post('/terminal/annotate', { function: 'WEI', context })
      .then(({ data: res }) => {
        if (!cancelled) setBrief(res.brief || '');
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
        <div className="term-loading">Loading world indices…</div>
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

  const regions = (data.regions || []).filter((region) =>
    data.rows.some((r) => r.region === region)
  );
  const asOf = data.asOf ? new Date(data.asOf) : null;

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">WEI</span>
        <span className="name">World Equity Indices</span>
        {asOf ? (
          <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
            {asOf.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        ) : null}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      <div>
        <div className="term-idx-head">
          <span>Index</span>
          <span>Last</span>
          <span>Chg</span>
          <span>Chg %</span>
        </div>
        {regions.map((region) => (
          <div key={region}>
            <div className="term-idx-region">{region}</div>
            {data.rows
              .filter((r) => r.region === region)
              .map((r) => {
                const cls =
                  r.change == null
                    ? ''
                    : r.change >= 0
                      ? 'pos'
                      : 'neg';
                return (
                  <div className="term-idx-row" key={r.symbol}>
                    <span className="name">
                      {r.name}
                      <span className="sym">{r.symbol}</span>
                    </span>
                    <span className="num">{fmt.level(r.last)}</span>
                    <span className={`num ${cls}`}>{fmt.chg(r.change)}</span>
                    <span className={`num ${cls}`}>
                      {fmt.pct(r.changePercent)}
                    </span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </div>
  );
}
