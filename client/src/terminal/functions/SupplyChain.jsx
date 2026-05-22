import { useEffect, useState } from 'react';
import api from '../../api/client.js';

// SPLC — supply-chain relationships read out of the focused ticker's
// latest 10-K. This is the honest, free-tier cousin of Bloomberg's SPLC:
// it does not have the quantified 100k-company graph, only what the
// company itself discloses — customers above the 10% threshold (with the
// stated percentage), named principal suppliers, and key inputs. The
// panel is explicit about its source so no one mistakes a filing read
// for Bloomberg's market-wide network. Customers carrying a stated
// revenue share render as exposure bars; everything else is a named
// list, each with the filing's own framing.

export default function SupplyChain({ ticker, onOpen }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    api
      .get(`/terminal/supply-chain/${encodeURIComponent(ticker)}`)
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

  if (!ticker) {
    return <div className="term-panel"><div className="term-loading">Enter a ticker to load SPLC.</div></div>;
  }
  if (loading) {
    return <div className="term-panel"><div className="term-loading">Reading {ticker.toUpperCase()}'s 10-K…</div></div>;
  }
  if (err) {
    return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  }
  if (!data) return null;

  const { customers = [], suppliers = [], materials = [], summary, concentration } = data;
  const empty = customers.length === 0 && suppliers.length === 0 && materials.length === 0;
  // A scale for the exposure bars: the largest stated customer share
  // pins the rail so a single 12% customer still reads as a full bar
  // rather than a sliver against an implied 100%.
  const maxPct = customers.reduce((m, c) => (c.pct != null && c.pct > m ? c.pct : m), 0);

  // Best-effort drill-through: hand the name to the command parser,
  // which resolves well-known public companies to a ticker, then open
  // its DES. Private or unresolved names simply don't open — there's no
  // ticker to land on, and inventing one would be worse than nothing.
  const lookup = (name) => async () => {
    try {
      const { data: cmd } = await api.post('/terminal/parse-command', { input: name });
      if (cmd?.ticker) onOpen?.({ ticker: cmd.ticker, fn: 'DES' });
    } catch {
      /* unresolved name: no-op */
    }
  };

  return (
    <div className="term-panel term-splc">
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="equity">Supply Chain</span>
        <span className="name">Relationships from the latest 10-K</span>
      </div>

      {summary ? (
        <div className="term-ai-block">
          <span className="label">◢ FILING READ</span>
          {summary}
        </div>
      ) : null}

      {concentration ? (
        <div className="term-splc-concentration">
          <span className="k">CUSTOMER CONCENTRATION</span>
          {concentration}
        </div>
      ) : null}

      {empty ? (
        <div className="term-loading">
          The latest 10-K names no specific customers, suppliers, or inputs — common for
          diversified consumer names that disclose no single customer above the 10% threshold.
        </div>
      ) : null}

      {customers.length ? (
        <div className="term-splc-section">
          <div className="term-splc-title">Customers</div>
          {customers.map((c) => (
            <div className="term-splc-row" key={c.name}>
              <button className="ent" onClick={lookup(c.name)} title={`Look up ${c.name}`}>
                {c.name}
              </button>
              {c.pct != null ? (
                <span className="track" title={`${c.pct}% of revenue`}>
                  <span className="fill" style={{ width: `${maxPct > 0 ? Math.max(4, (c.pct / maxPct) * 100) : 0}%` }} />
                </span>
              ) : (
                <span className="note">{c.note || ''}</span>
              )}
              <span className="pct">{c.pct != null ? `${c.pct}%` : '—'}</span>
            </div>
          ))}
        </div>
      ) : null}

      {suppliers.length ? (
        <div className="term-splc-section">
          <div className="term-splc-title">Suppliers &amp; Partners</div>
          {suppliers.map((sp) => (
            <div className="term-splc-row plain" key={sp.name}>
              <button className="ent" onClick={lookup(sp.name)} title={`Look up ${sp.name}`}>
                {sp.name}
              </button>
              <span className="note">{sp.note || ''}</span>
            </div>
          ))}
        </div>
      ) : null}

      {materials.length ? (
        <div className="term-splc-section">
          <div className="term-splc-title">Key Inputs &amp; Raw Materials</div>
          <div className="term-splc-chips">
            {materials.map((m) => (
              <span className="chip" key={m.name} title={m.note || ''}>{m.name}</span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="term-splc-source">
        Extracted by LLM from {data.sourceForm || '10-K'}
        {data.sourceDate ? ` filed ${data.sourceDate}` : ''} ·{' '}
        {data.sourceUrl ? (
          <a href={data.sourceUrl} target="_blank" rel="noreferrer">view filing</a>
        ) : null}
        . Names are the filing's; percentages only where the 10-K states them. Not a
        market-wide graph — this is a single-filing read, not Bloomberg's SPLC dataset.
      </div>
    </div>
  );
}
