import { useEffect, useMemo, useRef, useState } from 'react';
import { parseMnemonic } from './parser.js';
import { FUNCTIONS } from './registry.js';
import api from '../api/client.js';

// The amber command bar. Local mnemonic parse first; only falls back to the
// server's LLM parser if the input doesn't match any mnemonic pattern.
//
// As you type, the Bloomberg autocomplete drops out of the line: a ranked
// list of matching functions (carrying any ticker you've already typed)
// that the arrow keys walk and Enter/Tab fills. Plain-English input that
// matches no function leaves the menu empty and falls straight through to
// the LLM on Enter, so the "just ask a question" path is untouched.

const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;
const MAX_SUGGEST = 8;

// Split the raw line into an optional leading ticker and a function query.
// "AAPL DE" → {ticker: AAPL, q: DE}; "DE" → {q: DE}; "AAPL" → {ticker: AAPL}.
// A lone token is read as a function query when it prefixes a mnemonic,
// otherwise as a ticker if it's shaped like one.
function splitInput(raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!cleaned) return { ticker: null, q: '' };
  const tokens = cleaned.split(' ');
  if (tokens.length >= 2) {
    return { ticker: TICKER_RE.test(tokens[0]) ? tokens[0] : null, q: tokens.slice(1).join(' ') };
  }
  const t = tokens[0];
  if (FUNCTIONS.some((f) => f.id.startsWith(t))) return { ticker: null, q: t };
  if (TICKER_RE.test(t)) return { ticker: t, q: '' };
  return { ticker: null, q: t };
}

function scoreFn(f, q) {
  if (!q) return 1;
  const id = f.id;
  const label = f.label.toUpperCase();
  if (id === q) return 100;
  if (id.startsWith(q)) return 80;
  if (label.startsWith(q)) return 60;
  if (id.includes(q)) return 40;
  if (label.includes(q)) return 20;
  return -1;
}

export default function CommandBar({ onCommand, lastInterpretation }) {
  const [value, setValue] = useState('');
  const [parsing, setParsing] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  // Focus on mount so typing works without clicking.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Global "/" keyboard shortcut refocuses the command bar.
  useEffect(() => {
    function onKey(e) {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { ticker, q } = useMemo(() => splitInput(value), [value]);

  const suggestions = useMemo(() => {
    return FUNCTIONS.map((f) => ({ f, s: scoreFn(f, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_SUGGEST)
      .map((x) => x.f);
  }, [q]);

  // Every keystroke re-ranks the menu, so snap the highlight back to the
  // top match — otherwise the selection drifts onto whatever now sits at
  // the old index.
  useEffect(() => {
    setActive(0);
  }, [q]);

  const showMenu = open && !!value.trim() && suggestions.length > 0 && !parsing;

  function runFn(f) {
    onCommand({
      ticker: f.requires === 'ticker' ? ticker : null,
      function: f.id,
      args: null,
      explanation: null,
    });
    setValue('');
    setOpen(false);
  }

  async function submit() {
    const raw = value.trim();
    if (!raw || parsing) return;

    const local = parseMnemonic(raw);
    if (local) {
      onCommand({ ...local, explanation: null });
      setValue('');
      setOpen(false);
      return;
    }

    setParsing(true);
    try {
      const { data } = await api.post('/terminal/parse-command', { input: raw });
      onCommand(data);
      setValue('');
      setOpen(false);
    } catch {
      onCommand({
        ticker: null,
        function: 'HELP',
        args: null,
        explanation: 'Could not interpret. Try TICKER FUNCTION, e.g. AAPL DES.',
      });
    } finally {
      setParsing(false);
    }
  }

  function onKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      if (suggestions.length) setActive((i) => (i + 1) % suggestions.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (suggestions.length) setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
      return;
    }
    if (e.key === 'Escape') {
      if (showMenu) {
        e.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      // A highlighted function resolves instantly; only when the menu is
      // empty (plain-English input) do we hand off to the parser/LLM.
      if (showMenu && suggestions[active]) runFn(suggestions[active]);
      else submit();
      return;
    }
    if (e.key === 'Tab' && showMenu && suggestions[active]) {
      // Tab completes the line to the highlighted mnemonic without
      // running it, so the ticker stays editable.
      e.preventDefault();
      const f = suggestions[active];
      setValue(f.requires === 'ticker' && ticker ? `${ticker} ${f.id}` : f.id);
    }
  }

  const empty = value === '';

  return (
    <div className="term-commandbar">
      <span className="term-commandbar-prompt">&gt;</span>
      {empty ? <span className="term-commandbar-caret" aria-hidden="true" /> : null}
      <input
        ref={inputRef}
        className="term-commandbar-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKey}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        style={empty ? { caretColor: 'transparent' } : undefined}
        placeholder="TICKER FUNCTION  (e.g. AAPL DES)  ·  or ask in plain English"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
      />
      <button className="term-commandbar-go" onClick={submit} disabled={parsing || !value.trim()}>
        {parsing ? '…' : 'GO'}
      </button>
      {lastInterpretation?.explanation ? (
        <span className="term-commandbar-hint" title={lastInterpretation.explanation}>
          ◢ {lastInterpretation.explanation.length > 60
            ? lastInterpretation.explanation.slice(0, 57) + '…'
            : lastInterpretation.explanation}
        </span>
      ) : null}

      {showMenu ? (
        <div className="term-cmd-suggest">
          <div className="term-cmd-suggest-head">
            <span>{ticker ? `${ticker} · functions` : 'functions'}</span>
            <span>↑↓ select · ↵ run · tab fill</span>
          </div>
          {suggestions.map((f, i) => {
            const needsTkr = f.requires === 'ticker';
            const mnem = needsTkr && ticker ? `${ticker} ${f.id}` : f.id;
            return (
              <div
                key={f.id}
                className={`term-cmd-row${i === active ? ' active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  // Fire before the input's blur tears the menu down.
                  e.preventDefault();
                  runFn(f);
                }}
              >
                <span className="num">{i + 1})</span>
                <span className="mnem">
                  {mnem}
                  {needsTkr && !ticker ? <span className="tkr"> &lt;tkr&gt;</span> : null}
                </span>
                <span className="label">{f.help || f.label}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
