import { useEffect, useRef, useState } from 'react';
import { parseMnemonic } from './parser.js';
import api from '../api/client.js';

// The amber command bar. Local mnemonic parse first; only falls back to the
// server's LLM parser if the input doesn't match any mnemonic pattern.

export default function CommandBar({ onCommand, lastInterpretation }) {
  const [value, setValue] = useState('');
  const [parsing, setParsing] = useState(false);
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

  async function submit() {
    const raw = value.trim();
    if (!raw || parsing) return;

    const local = parseMnemonic(raw);
    if (local) {
      onCommand({ ...local, explanation: null });
      setValue('');
      return;
    }

    setParsing(true);
    try {
      const { data } = await api.post('/terminal/parse-command', { input: raw });
      onCommand(data);
      setValue('');
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
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="term-commandbar">
      <span className="term-commandbar-prompt">&gt;</span>
      <input
        ref={inputRef}
        className="term-commandbar-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
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
    </div>
  );
}
