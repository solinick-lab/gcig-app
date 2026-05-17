// MGMT parsers. Each takes proxyStatement sections (plain text) and
// returns structured, per-field-nullable data. Pure, never throws.
// DEF 14A prose is irregular; these favor recall and return null for
// anything they can't confidently extract — the panel shows "—".
import { parseHtml, cellText, tableRows, findTableBySignature, headerMap, locateSectionText } from './htmlExtract.js';

const TITLES = [
  'Chief Executive Officer', 'Chief Financial Officer', 'Chief Operating Officer',
  'President', 'Chief Technology Officer', 'Chief Accounting Officer',
  'General Counsel', 'Chief Legal Officer', 'Executive Chairman',
];
const TITLE_RE = new RegExp(`(${TITLES.join('|')})`, 'i');

// "Jane A. Doe, 54, has served as Chief Executive Officer since 2018"
// TOKEN matches one capitalized name word. The first alternative handles
// ordinary mixed-case words (e.g. "Doe", "DeLuca"). The second handles the
// Irish O'Xxxx form ("O'Brien", "O'Connor") whose second character is an
// apostrophe, not a lowercase letter. All-caps section headings ("OFFICERS")
// and period-terminated abbreviations ("Corp.") don't satisfy either branch.
const TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";

// Build EXEC_RE from TOKEN so the name-token rule is defined in one place.
// The since-fragment accepts "since YYYY", "since Month YYYY", and
// "since Month D, YYYY" — any word-or-digit tokens between "since" and
// the 4-digit year, capped at two optional word-groups so we don't run
// across unrelated text.
const EXEC_RE = new RegExp(
  `(${TOKEN}(?:\\s+(?:[A-Z]\\.|${TOKEN}))+),\\s*(\\d{2}),[^.]*?\\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\\b` +
  `(?:[^.]*?since\\s+(?:[A-Za-z]+\\s+){0,2}(?:\\d{1,2},?\\s*)?(\\d{4})|[^.]*)`,
  'g',
);

export function parseLeadership(sections) {
  const text = sections?.execBios || '';
  const execs = [];
  let m;
  EXEC_RE.lastIndex = 0;
  while ((m = EXEC_RE.exec(text)) !== null) {
    const title = m[3].replace(/\s+/g, ' ').trim();
    execs.push({
      name: m[1].replace(/\s+/g, ' ').trim(),
      title,
      age: m[2] ? Number(m[2]) : null,
      since: m[4] ? Number(m[4]) : null,
      priorRoles: priorRoles(text, m[1]),
      totalComp: null,
    });
  }
  const ceo =
    execs.find((e) => /chief executive officer/i.test(e.title)) || execs[0] || null;
  return { ceo: ceo || null, execs };
}

// Best-effort: a sentence after the person's name mentioning a prior
// "President/CEO/… of <Company>". Null when nothing clean is found.
function priorRoles(text, name) {
  const i = text.indexOf(name);
  if (i < 0) return [];
  const after = text.slice(i, i + 600);
  const out = [];
  // Honorific periods (Ms. Mr. Dr. Jr. Sr.) must not terminate a sentence
  // scan, so each [^.]*? fragment is widened to skip over them. The `i`
  // flag handles "Formerly" / "PREVIOUSLY" / etc. without duplication.
  const re = /\b(?:prior(?:\sto)?|previously|formerly)\b(?:(?:Ms|Mr|Dr|Jr|Sr)\.|[^.])*?\b(President|Chief [A-Za-z ]+Officer|Partner|Director)\b(?:(?:Ms|Mr|Dr|Jr|Sr)\.|[^.])*?\bof\s+([A-Z][A-Za-z.,& ]{2,40}?)[.,]/gi;
  let r;
  while ((r = re.exec(after)) !== null && out.length < 3) {
    out.push(`${r[1].trim()}, ${r[2].trim()}`);
  }
  return out;
}

const COMMITTEE_NAMES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

const BOARD_SIG = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  return /\bage\b/.test(j) && /(director since|\bsince\b)/.test(j) && /name|director|nominee/.test(j);
};

// Director roster. Prefer the nominee/director table (header has Age +
// a since column), found by signature anywhere in the DOM (TOC-proof,
// colspan/nesting handled by htmlExtract). otherBoards prefers a
// dedicated column; committees from its column or row text. If no such
// table exists, fall back to per-director record blocks in the located
// "Election of Directors" section text.
export function parseBoard(html) {
  const root = parseHtml(html);
  const table = findTableBySignature(root, BOARD_SIG);
  const out = [];
  if (table) {
    const all = tableRows(table);
    const hIdx = all.findIndex((cells) => BOARD_SIG(cells));
    if (hIdx >= 0) {
      const h = headerMap(all[hIdx]);
      if (h.name !== undefined && h.age !== undefined) {
        for (let i = hIdx + 1; i < all.length; i++) {
          const c = all[i];
          const name = (c[h.name] || '').replace(/\s+/g, ' ').trim();
          const age = Number(String(c[h.age] || '').replace(/[^0-9]/g, ''));
          if (!name || /^name$|^director$/i.test(name) || !Number.isFinite(age) || age < 18 || age > 100) continue;
          const since =
            h.since !== undefined
              ? Number((String(c[h.since] || '').match(/\b(19|20)\d{2}\b/) || [])[0]) || null
              : null;
          const committees =
            h.committees !== undefined
              ? COMMITTEE_NAMES.filter((cm) => new RegExp(cm, 'i').test(c[h.committees] || ''))
              : COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(c.join(' ')));
          const otherBoards =
            h.otherboards !== undefined
              ? (c[h.otherboards] || '')
                  .split(/;|\band\b|,(?![^()]*\))/)
                  .map((s) => s.replace(/\s+/g, ' ').trim().replace(/[.;]$/, ''))
                  .filter((s) => s.length > 2 && /^[A-Z]/.test(s) && !/committee|none\b/i.test(s))
              : [];
          out.push({ name, age, since, committees, otherBoards: [...new Set(otherBoards)] });
        }
      }
    }
    if (out.length) return out;
  }
  // Fallback: per-director record blocks in the located section text.
  const txt =
    locateSectionText(root, /election of directors|nominees? for director|board of directors/i) ||
    cellText(root);
  const TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
  const HEAD = new RegExp(`(${TOKEN}(?:\\s+${TOKEN}){1,3}),\\s*age\\s*(\\d{2})`, 'g');
  const heads = [];
  let m;
  while ((m = HEAD.exec(txt)) !== null) heads.push({ name: m[1].trim(), age: Number(m[2]), at: m.index });
  return heads.map((hd, i) => {
    const w = txt.slice(hd.at, i + 1 < heads.length ? heads[i + 1].at : txt.length);
    const since = (w.match(/(?:director since|since)\s+(?:[A-Za-z]+\s+){0,2}(?:\d{1,2},?\s*)?((?:19|20)\d{2})/i) || [])[1];
    return {
      name: hd.name,
      age: hd.age,
      since: since ? Number(since) : null,
      committees: COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(w)),
      otherBoards: [],
    };
  });
}

const toNum = (s) => {
  const cleaned = String(s == null ? '' : s)
    .replace(/\([\w\d.,]+\)/g, '')   // strip footnote refs e.g. (3) (a) (1,234)
    .replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

// Real SCT cells are "<Name> <Title>" with the title often containing
// "President" before the real C-suite title (e.g. "Senior Vice
// President and Chief Financial Officer"). A lazy regex stops at the
// FIRST alternative regardless of order, mis-splitting the name and
// reporting "President". Take the LAST C-suite/GC/Chairman title; only
// fall back to bare President if none exists.
function splitNameTitle(cell) {
  const PRIORITY_RE = /\b(Chief [A-Za-z ]+?Officer|General Counsel|Executive Chairman)\b/g;
  let best = null, m;
  while ((m = PRIORITY_RE.exec(cell)) !== null) best = m;
  if (best) {
    const name = cell
      .slice(0, best.index)
      .replace(/[,;]?\s*(Senior\s+)?(Executive\s+)?Vice\s+President\b.*/i, '')
      .replace(/[,;]?\s*President\b.*/i, '')
      .replace(/\s+and\s*$/i, '')
      .replace(/[,;]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return { name, title: best[1].trim() };
  }
  const pres = /(?:^|\W)President\b/.exec(cell);
  if (pres) {
    const idx = cell.indexOf('President', pres.index);
    return { name: cell.slice(0, idx).replace(/\s+/g, ' ').trim().replace(/[,;]$/, ''), title: 'President' };
  }
  return { name: cell.replace(/\s+/g, ' ').trim().replace(/[,;]$/, ''), title: '' };
}

// Summary Compensation Table, found by header signature anywhere in the
// DOM (TOC-proof). Requires a name column in the signature so a
// table-of-contents/narrative table can't false-positive. Columns are
// read by header index (not position) so blank/extra columns don't
// misalign the mix.
const SCT_SIG = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  return (
    /salary/.test(j) &&
    /\btotal\b/.test(j) &&
    /name|principal position/.test(j) &&
    [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 2
  );
};

export function parseComp(html) {
  const root = parseHtml(html);
  const table = findTableBySignature(root, SCT_SIG);
  if (!table) return { rows: [] };
  const all = tableRows(table);
  const hIdx = all.findIndex((cells) => SCT_SIG(cells));
  if (hIdx < 0) return { rows: [] };
  const h = headerMap(all[hIdx]);
  if (h.name === undefined || h.total === undefined) return { rows: [] };

  const rows = [];
  const seen = new Set();
  for (let i = hIdx + 1; i < all.length; i++) {
    const c = all[i];
    const nameCell = (c[h.name] || '').trim();
    if (!nameCell || /^name|director|^total$/i.test(nameCell)) continue;
    const total = toNum(c[h.total]);
    if (!total) continue;
    const { name, title } = splitNameTitle(nameCell);
    if (!name || seen.has(name)) continue; // first (latest year) row per officer
    seen.add(name);
    const salary = h.salary !== undefined ? toNum(c[h.salary]) : null;
    const stock = h.stock !== undefined ? toNum(c[h.stock]) : null;
    const option = h.option !== undefined ? toNum(c[h.option]) : null;
    const haveCols = [salary, stock, option].filter((v) => v != null).length >= 2;
    const pct = (v) => (haveCols && v != null ? Math.round((v / total) * 100) : null);
    const otherPct = haveCols
      ? Math.max(0, Math.round(((total - (salary || 0) - (stock || 0) - (option || 0)) / total) * 100))
      : null;
    rows.push({ name, title, total, salaryPct: pct(salary), stockPct: pct(stock), optionPct: pct(option), otherPct });
  }
  return { rows };
}

// Interlocking directorates, bounded to the fund's own holdings: a
// director of the focus company who also sits on the board of another
// name the fund holds is an edge focus<->thatHolding. Name match is
// loose (case-insensitive substring either direction) — proxy company
// names rarely match the sheet exactly.
function holdingFor(name, holdings) {
  const n = String(name || '').toLowerCase().replace(/[.,]/g, '').trim();
  if (!n) return null;
  for (const h of holdings) {
    const hn = String(h.name || '').toLowerCase().replace(/[.,]/g, '').trim();
    if (hn && (hn.includes(n) || n.includes(hn))) return h.ticker;
  }
  return null;
}

export function buildNetwork(focusTicker, board, holdings) {
  const f = String(focusTicker || '').toUpperCase();
  if (!f || !Array.isArray(board) || !Array.isArray(holdings)) {
    return { nodes: [], edges: [] };
  }
  const nodes = new Set();
  const edges = [];
  for (const d of board) {
    for (const ob of d?.otherBoards || []) {
      const tk = holdingFor(ob, holdings);
      if (tk && tk.toUpperCase() !== f) {
        nodes.add(f);
        nodes.add(tk);
        edges.push({ person: d.name, a: f, b: tk });
      }
    }
  }
  return { nodes: [...nodes], edges };
}
