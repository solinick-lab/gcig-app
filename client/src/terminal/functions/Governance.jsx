import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';

// MGMT — leadership / board / comp / network from the latest DEF 14A.
// Every section is best-effort; missing fields render as "—".

const TABS = ['Leadership', 'Board', 'Comp', 'Network'];
const dash = (v) => (v == null || v === '' ? '—' : v);

export default function Governance({ ticker }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('Leadership');
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
      .get(`/terminal/governance/${encodeURIComponent(ticker)}`)
      .then(({ data: d }) => {
        if (!cancelled) setData(d);
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

  useEffect(() => {
    if (!ticker || !data) return;
    let cancelled = false;
    setBriefLoading(true);
    const ctx = [
      data.ceo ? `CEO: ${data.ceo.name} (${dash(data.ceo.title)}), age ${dash(data.ceo.age)}, since ${dash(data.ceo.since)}` : null,
      `Board: ${(data.board || []).length} directors`,
      (data.comp?.rows || []).map((r) => `${r.name} pay: ${dash(r.salaryPct)}% sal / ${dash(r.stockPct)}% stk / ${dash(r.optionPct)}% opt`).join('; '),
      (data.network?.edges || []).length ? `Shared boards with holdings: ${data.network.edges.map((e) => `${e.person} ${e.a}-${e.b}`).join(', ')}` : null,
    ].filter(Boolean).join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'MGMT', context: ctx })
      .then(({ data: r }) => { if (!cancelled) setBrief(r.brief || ''); })
      .catch(() => { if (!cancelled) setBrief(''); })
      .finally(() => { if (!cancelled) setBriefLoading(false); });
    return () => { cancelled = true; };
  }, [data, ticker]);

  if (!ticker) return <div className="term-panel"><div className="term-loading">Enter a ticker to load governance.</div></div>;
  if (loading) return <div className="term-panel"><div className="term-loading">Loading DEF 14A…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!data) return null;

  const noProxy = data.source == null;

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Management &amp; Board</span>
        {data.asOf && <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>DEF 14A {data.asOf}</span>}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {noProxy ? (
        <div className="term-loading">No recent DEF 14A on file for {ticker.toUpperCase()}.</div>
      ) : (
        <>
          <div className="term-tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={`term-tab${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Leadership' && (
            <div>
              {data.ceo && (
                <div style={{ marginBottom: 8 }}>
                  <div className="sym" style={{ fontSize: 13 }}>{data.ceo.name} · {dash(data.ceo.title)}</div>
                  <div style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
                    age {dash(data.ceo.age)} · since {dash(data.ceo.since)}
                    {data.ceo.priorRoles?.length ? ` · prior: ${data.ceo.priorRoles.join('; ')}` : ''}
                  </div>
                </div>
              )}
              <table className="term-table">
                <thead><tr><th>Executive</th><th>Title</th><th className="num">Age</th><th className="num">Since</th></tr></thead>
                <tbody>
                  {(data.execs || []).map((e, i) => (
                    <tr key={i}><td className="sym">{e.name}</td><td>{dash(e.title)}</td><td className="num">{dash(e.age)}</td><td className="num">{dash(e.since)}</td></tr>
                  ))}
                </tbody>
              </table>
              {(data.execs || []).length === 0 && <div className="term-loading">No executive bios parsed.</div>}
            </div>
          )}

          {tab === 'Board' && (
            <table className="term-table">
              <thead><tr><th>Director</th><th className="num">Age</th><th className="num">Since</th><th>Committees</th><th>Other public boards</th></tr></thead>
              <tbody>
                {(data.board || []).map((d, i) => (
                  <tr key={i}>
                    <td className="sym">{d.name}</td>
                    <td className="num">{dash(d.age)}</td>
                    <td className="num">{dash(d.since)}</td>
                    <td>{d.committees?.length ? d.committees.join(', ') : '—'}</td>
                    <td>{d.otherBoards?.length ? d.otherBoards.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'Comp' && (
            <table className="term-table">
              <thead><tr><th>Name</th><th className="num">Salary%</th><th className="num">Stock%</th><th className="num">Option%</th><th className="num">Other%</th><th className="num">Total</th></tr></thead>
              <tbody>
                {(data.comp?.rows || []).map((r, i) => (
                  <tr key={i}>
                    <td className="sym">{r.name}</td>
                    <td className="num">{dash(r.salaryPct)}</td>
                    <td className="num">{dash(r.stockPct)}</td>
                    <td className="num">{dash(r.optionPct)}</td>
                    <td className="num">{dash(r.otherPct)}</td>
                    <td className="num">{r.total == null ? '—' : `$${Number(r.total).toLocaleString()}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'Network' && (
            (data.network?.edges || []).length === 0 ? (
              <div className="term-loading">No shared boards among current fund holdings.</div>
            ) : (
              <table className="term-table">
                <thead><tr><th>Director</th><th>Focus</th><th>Also on (held)</th></tr></thead>
                <tbody>
                  {data.network.edges.map((e, i) => (
                    <tr key={i}><td className="sym">{e.person}</td><td>{e.a}</td><td className="num">{e.b}</td></tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Parsed best-effort from the latest DEF 14A · fields may be partial for some filers.
      </div>
    </div>
  );
}
