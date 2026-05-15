// Client-side mnemonic parser. Mirrors server/src/routes/terminal.js#mnemonicParse
// so the obvious cases (TICKER FN, single function, single ticker) never need
// a server round-trip. Natural-language input that doesn't parse here falls
// through to the LLM via POST /api/terminal/parse-command.

import { FUNCTION_IDS } from './registry.js';

export function parseMnemonic(input) {
  const cleaned = String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  if (!cleaned) return null;
  const parts = cleaned.split(' ');

  if (parts.length === 1) {
    const tok = parts[0];
    if (FUNCTION_IDS.has(tok)) return { ticker: null, function: tok, args: null };
    if (/^[A-Z][A-Z0-9.\-]{0,11}$/.test(tok)) return { ticker: tok, function: 'DES', args: null };
    return null;
  }

  const [t, f, ...rest] = parts;

  if (FUNCTION_IDS.has(f) && /^[A-Z][A-Z0-9.\-]{0,11}$/.test(t)) {
    return { ticker: t, function: f, args: rest.length ? rest.join(' ').slice(0, 80) : null };
  }

  if (FUNCTION_IDS.has(t)) {
    return { ticker: null, function: t, args: rest.length ? [f, ...rest].join(' ').slice(0, 80) : f };
  }

  return null;
}
