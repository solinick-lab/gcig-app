import { FUNCTIONS } from '../registry.js';

export default function Help() {
  return (
    <div className="term-panel">
      <div className="term-panel-header">
        <span className="ticker">HELP</span>
        <span className="name">Available terminal functions</span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--term-fg-dim)', marginBottom: 4 }}>
        Type <span style={{ color: 'var(--term-fg)' }}>TICKER FUNCTION</span> then <span style={{ color: 'var(--term-fg)' }}>GO</span> (Enter).
        Examples: <span style={{ color: 'var(--term-fg)' }}>AAPL DES</span> · <span style={{ color: 'var(--term-fg)' }}>NVDA GP</span> · <span style={{ color: 'var(--term-fg)' }}>BI</span>.
        Or just type a question in plain English.
      </div>

      <div className="term-help-grid">
        {FUNCTIONS.map((f) => (
          <div className="term-help-cell" key={f.id}>
            <div className="mnemonic">
              {f.requires === 'ticker' ? '<TKR> ' : ''}
              {f.id}
            </div>
            <div className="desc">{f.help}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
