export default function ComingSoon({ ticker, fn }) {
  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">{fn?.id || '—'}</span>
        <span className="name">{fn?.label || ''}{ticker ? ` · ${ticker.toUpperCase()}` : ''}</span>
      </div>
      <div style={{ color: 'var(--term-fg-dim)', fontSize: 12, padding: '20px 0' }}>
        Function not yet implemented in this build. Coming in a follow-up.
      </div>
      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Type <span style={{ color: 'var(--term-fg)' }}>HELP</span> for the full function list, or
        try <span style={{ color: 'var(--term-fg)' }}>{ticker ? `${ticker} DES` : 'AAPL DES'}</span>.
      </div>
    </div>
  );
}
