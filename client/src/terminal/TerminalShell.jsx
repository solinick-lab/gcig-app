import { useCallback, useMemo, useState } from 'react';
import { Mosaic, MosaicWindow } from 'react-mosaic-component';
import 'react-mosaic-component/react-mosaic-component.css';
import CommandBar from './CommandBar.jsx';
import { getFunction, FUNCTIONS } from './registry.js';
import { useAuth } from '../context/AuthContext.jsx';

// TerminalShell — the amber/black workstation. Owns:
//   - The data-theme scoping (so the rest of the app is unaffected)
//   - Topbar + command bar + status bar
//   - The mosaic of panes; each pane is bound to a paneId -> { ticker, function }
//
// Mosaic value here is a tree of paneIds. We keep a separate `panes` map from
// paneId -> { ticker, fn } so the same pane keeps its state across layout
// drags. New panes get a fresh id; closing a pane drops its entry from the map.

// No ticker pre-loaded. The landing layout shows market-wide panels so
// the terminal is useful the moment it opens. Typing a ticker (e.g.
// "HD DES") in the command bar takes over the focused pane.
const DEFAULT_PANES = {
  a: { ticker: null, fn: 'TOP' },
  b: { ticker: null, fn: 'MOVR' },
  c: { ticker: null, fn: 'HELP' },
  d: { ticker: null, fn: 'BI' },
};

const DEFAULT_LAYOUT = {
  direction: 'row',
  first: {
    direction: 'column',
    first: 'a',
    second: 'b',
    splitPercentage: 55,
  },
  second: {
    direction: 'column',
    first: 'c',
    second: 'd',
    splitPercentage: 40,
  },
  splitPercentage: 55,
};

let paneIdSeq = 100;
function nextPaneId() {
  paneIdSeq += 1;
  return `p${paneIdSeq}`;
}

export default function TerminalShell({ onExit }) {
  const { user } = useAuth();
  const [layout, setLayout] = useState(DEFAULT_LAYOUT);
  const [panes, setPanes] = useState(DEFAULT_PANES);
  const [focusedPaneId, setFocusedPaneId] = useState('a');
  const [lastInterpretation, setLastInterpretation] = useState(null);

  // Build a workspace context blob to hand the AI chat panel.
  const workspaceContext = useMemo(() => {
    const lines = ['GCIG Terminal workspace:'];
    for (const [id, p] of Object.entries(panes)) {
      const fn = getFunction(p.fn);
      const focused = id === focusedPaneId ? ' [focused]' : '';
      lines.push(`- pane ${id}${focused}: ${p.fn} (${fn?.label || p.fn})${p.ticker ? ` for ${p.ticker}` : ''}`);
    }
    if (user?.role) lines.push(`Viewer role: ${user.role}`);
    return lines.join('\n');
  }, [panes, focusedPaneId, user]);

  // Apply a parsed command to the focused pane.
  const applyCommand = useCallback(
    (cmd) => {
      if (!cmd?.function) return;
      setLastInterpretation(cmd._source === 'llm' ? cmd : null);
      setPanes((p) => {
        const target = p[focusedPaneId] || { ticker: null, fn: 'DES' };
        return {
          ...p,
          [focusedPaneId]: {
            ticker: cmd.ticker || target.ticker,
            fn: cmd.function,
          },
        };
      });
    },
    [focusedPaneId]
  );

  const renderTile = useCallback(
    (paneId, path) => {
      const pane = panes[paneId] || { ticker: null, fn: 'HELP' };
      const fnDef = getFunction(pane.fn);
      const Comp = fnDef?.component;
      const isFocused = paneId === focusedPaneId;

      const title = (() => {
        const fnLabel = fnDef?.label || pane.fn;
        if (pane.ticker && fnDef?.requires === 'ticker') {
          return `${pane.ticker} · ${pane.fn} · ${fnLabel}`;
        }
        return `${pane.fn} · ${fnLabel}`;
      })();

      const toolbarControls = (
        <div style={{ display: 'flex', gap: 6 }}>
          <FunctionSwitcher
            current={pane.fn}
            onChange={(newFn) => {
              setPanes((p) => ({ ...p, [paneId]: { ...p[paneId], fn: newFn } }));
            }}
          />
        </div>
      );

      return (
        <MosaicWindow
          path={path}
          title={title}
          toolbarControls={toolbarControls}
          renderToolbar={() => (
            <div
              className="mosaic-window-toolbar"
              onMouseDown={() => setFocusedPaneId(paneId)}
              style={isFocused ? { borderBottomColor: 'var(--term-border-focused)' } : undefined}
            >
              <div className="mosaic-window-title">{title}</div>
              {toolbarControls}
            </div>
          )}
        >
          <div
            onMouseDown={() => setFocusedPaneId(paneId)}
            style={{ height: '100%', overflow: 'auto' }}
          >
            {Comp ? (
              <Comp
                ticker={pane.ticker}
                fn={fnDef}
                workspaceContext={workspaceContext}
              />
            ) : null}
          </div>
        </MosaicWindow>
      );
    },
    [panes, focusedPaneId, workspaceContext]
  );

  return (
    <div className="terminal-root" data-theme="terminal">
      <div className="term-topbar">
        <span className="term-topbar-brand">GCIG TERMINAL</span>
        <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>v0</span>
        <div className="term-topbar-status">
          <span><span className="dot" /> CONNECTED</span>
          <span>·</span>
          <span>{user?.name || 'USER'}</span>
          <button className="term-topbar-exit" onClick={onExit}>EXIT</button>
        </div>
      </div>

      <CommandBar onCommand={applyCommand} lastInterpretation={lastInterpretation} />

      <div className="term-workspace">
        <Mosaic
          renderTile={renderTile}
          value={layout}
          onChange={setLayout}
        />
      </div>

      <div className="term-statusbar">
        <span>FOCUSED: {focusedPaneId.toUpperCase()}</span>
        <span className="sep">|</span>
        <span>{panes[focusedPaneId]?.ticker || '—'} · {panes[focusedPaneId]?.fn || '—'}</span>
        <span className="sep">|</span>
        <span>HELP HELP &lt;GO&gt; for function list</span>
        <span style={{ marginLeft: 'auto' }}>{new Date().toLocaleDateString()}</span>
      </div>
    </div>
  );
}

function FunctionSwitcher({ current, onChange }) {
  return (
    <select
      value={current}
      onChange={(e) => onChange(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        background: 'var(--term-bg-panel)',
        color: 'var(--term-fg)',
        border: '1px solid var(--term-border)',
        font: 'inherit',
        fontSize: 11,
        padding: '1px 4px',
        letterSpacing: '0.06em',
      }}
    >
      {FUNCTIONS.map((f) => (
        <option key={f.id} value={f.id}>
          {f.id} · {f.label}
        </option>
      ))}
    </select>
  );
}
