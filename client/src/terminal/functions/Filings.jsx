import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// FIL — a ticker's recent SEC filings straight off the EDGAR
// submissions feed (8-K, 10-Q, 10-K, DEF 14A, Form 4 …). Requires a
// ticker. Mirrors Peers/InsiderActivity: fetch, render the shared
// term-table, then hand a compact filing list to /annotate for the
// AI brief. Filings link OUT to the SEC document (external, new tab)
// — they are not internal terminal functions, so there is no
// onOpen/DES wiring here.

// EDGAR hands dates as ISO YYYY-MM-DD strings. Parse as a local date
// (not new Date('2026-05-01'), which is UTC midnight and can slip a
// day west of GMT) and render the terminal's compact MM/DD/YY.
const fmtDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  if (!m) return '—';
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
};

export default function Filings({ ticker }) {
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
      .get(`/terminal/filings/${encodeURIComponent(ticker)}`)
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

  // The confab-safe guard: with zero filings there is nothing for the
  // model to read, so we never call /annotate — the panel shows an
  // honest "no recent filings" line instead of inviting a fabricated
  // brief. Same posture Peers/InsiderActivity take when their data set
  // is empty.
  useEffect(() => {
    const filings = data?.filings;
    if (!Array.isArray(filings) || filings.length === 0) return;
    let cancelled = false;
    setBriefLoading(true);
    const context = [
      `Recent SEC filings for ${data.ticker} (newest first):`,
      ...filings
        .slice(0, 40)
        .map(
          (f) =>
            `${fmtDate(f.filingDate)} ${f.form || '—'} — ${f.description || f.form || 'Filing'}`
        ),
    ].join('\n');
    api
      .post('/terminal/annotate', { ticker: data.ticker, function: 'FIL', context })
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

  if (!ticker) {
    return (
      <div className="term-panel">
        <div className="term-loading">Enter a ticker to load filings.</div>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="term-panel">
        <div className="term-loading">Loading filings for {ticker.toUpperCase()}…</div>
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

  const filings = Array.isArray(data.filings) ? data.filings : [];

  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{data.ticker}</span>
        <span className="name">
          SEC Filings{filings.length ? ` · ${filings.length} recent` : ''}
        </span>
      </div>

      {filings.length === 0 ? (
        <div className="term-loading">
          No recent SEC filings for {data.ticker}. Cash labels, ETFs with
          sparse schedules, and thinly-covered foreign issues often have
          nothing in the recent EDGAR window.
        </div>
      ) : (
        <>
          <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
            <span className="label">◢ AI BRIEF</span>
            {briefLoading ? 'Generating…' : brief || 'No brief available.'}
          </div>

          <table className="term-table">
            <thead>
              <tr>
                <th>Form</th>
                <th>Filed</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {filings.map((f, i) => (
                <tr key={`${f.accessionNumber || f.url || f.form}-${i}`}>
                  <td className="sym">
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${f.form || 'filing'} on SEC.gov`}
                    >
                      {f.form || '—'}
                    </a>
                  </td>
                  <td>{fmtDate(f.filingDate)}</td>
                  <td>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${f.form || 'filing'} on SEC.gov`}
                    >
                      {f.description || f.form || 'Filing'}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        SEC EDGAR submissions feed · newest first · 6h cache · each row
        opens the filing on SEC.gov in a new tab.
      </div>
    </div>
  );
}
