import { useEffect, useState } from 'react';
import api from '../../api/client.js';
import PDFModal from '../../components/PDFModal.jsx';

// FIL — a ticker's recent SEC filings straight off the EDGAR
// submissions feed (8-K, 10-Q, 10-K, DEF 14A, Form 4 …). Requires a
// ticker. Mirrors Peers/InsiderActivity: fetch, render the shared
// term-table, then hand a compact filing list to /annotate for the
// AI brief. v1.1 routes a plain row click into the in-app PDFModal so
// the document opens inside the terminal instead of stealing a new
// tab; cmd/ctrl/shift/middle-click still fall through to the native
// new-tab path for power users who rely on it.

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
  // The filing currently open in the in-app modal, or null. Passing
  // { url, title } in the same shape PitchRequests/Votes use keeps
  // the call site identical to the pitch-deck wiring.
  const [selectedDoc, setSelectedDoc] = useState(null);

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
              {filings.map((f, i) => {
                const docTitle = `${data.ticker} ${f.form || 'Filing'} · ${fmtDate(f.filingDate)}`;
                // Plain primary click opens the in-terminal modal;
                // cmd/ctrl/shift/alt and middle-click fall through to
                // the native target=_blank so power users keep their
                // familiar new-tab escape. SEC may still block the
                // iframe via X-Frame-Options — the modal's header
                // carries the always-visible new-tab fallback for
                // that case.
                const onRowClick = (e) => {
                  if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                    e.preventDefault();
                    setSelectedDoc({ url: f.url, title: docTitle });
                  }
                };
                return (
                  <tr key={`${f.accessionNumber || f.url || f.form}-${i}`}>
                    <td className="sym">
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${f.form || 'filing'} on SEC.gov`}
                        onClick={onRowClick}
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
                        onClick={onRowClick}
                      >
                        {f.description || f.form || 'Filing'}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        SEC EDGAR submissions feed · newest first · 6h cache · click a
        row to preview the filing inline; cmd/ctrl/middle-click still
        opens it in a new tab.
      </div>

      <PDFModal
        url={selectedDoc?.url}
        title={selectedDoc?.title}
        onClose={() => setSelectedDoc(null)}
      />
    </div>
  );
}
