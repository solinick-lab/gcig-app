// MGMT parsers. Each takes proxyStatement sections (plain text) and
// returns structured, per-field-nullable data. Pure, never throws.
// DEF 14A prose is irregular; these favor recall and return null for
// anything they can't confidently extract — the panel shows "—".
import { parseHtml, cellText, tableRows, findTableBySignature, headerMap, locateSectionText } from './htmlExtract.js';

// One name-token rule for the leadership parser. The first alternative
// covers ordinary mixed-case words ("Doe", "DeLuca"); the second covers
// Irish O'Xxxx forms ("O'Brien") whose second character is an apostrophe.
// All-caps headings ("OFFICERS") and period-terminated abbreviations
// ("Corp.") satisfy neither branch — intentional.
const NAME_TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
const EXEC_RE = new RegExp(
  `(${NAME_TOKEN}(?:\\s+(?:[A-Z]\\.|${NAME_TOKEN})){1,3}),\\s*(\\d{2}),[^.]*?\\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\\b(?:[^.]*?since\\s+(?:[A-Za-z]+\\s+){0,2}(?:\\d{1,2},?\\s*)?((?:19|20)\\d{2})|[^.]*)`,
  'g'
);

function priorRoles(text, name) {
  const i = text.indexOf(name);
  if (i < 0) return [];
  const after = text.slice(i, i + 600);
  const out = [];
  const re = /\b(?:prior(?:\sto)?|previously|formerly)\b(?:(?:Ms|Mr|Dr|Jr|Sr)\.|[^.])*?\b(President|Chief [A-Za-z ]+Officer|Partner|Director)\b[^.]*?\bof\s+([A-Z][A-Za-z.,& ]{2,40}?)[.,]/gi;
  let r;
  while ((r = re.exec(after)) !== null && out.length < 3) out.push(`${r[1].trim()}, ${r[2].trim()}`);
  return out;
}

// Best-effort tier: DOM-locate the exec-officers block, then prose-parse.
// Exec bios are narrative even in well-structured proxies — inherently
// lower recall than the table tiers; stated honestly in the spec/UI.
export function parseLeadership(html) {
  const root = parseHtml(html);
  const text =
    locateSectionText(
      root,
      /information about (?:our )?executive officers|(?:our )?executive officers of the (?:company|registrant)|^(?:our )?executive officers$/i
    ) || '';
  const execs = [];
  EXEC_RE.lastIndex = 0;
  let m;
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
  const ceo = execs.find((e) => /chief executive officer/i.test(e.title)) || execs[0] || null;
  return { ceo: ceo || null, execs };
}

const COMMITTEE_NAMES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

// name + a since/tenure column is enough — many large-cap director
// tables have no Age column (age is in bio prose). Age stays optional.
const BOARD_SIG = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  const hasSince = /(director since|\bsince\b|tenure|year.*elected|first elected)/.test(j);
  const hasName = /name|director|nominee/.test(j);
  return hasName && hasSince;
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
      if (h.name !== undefined) {
        for (let i = hIdx + 1; i < all.length; i++) {
          const c = all[i];
          const name = (c[h.name] || '').replace(/\s+/g, ' ').trim();
          // Age optional (no Age column on many large-caps); strip
          // footnote refs by taking the first digit run.
          const age =
            h.age !== undefined
              ? Number((String(c[h.age] || '').match(/\d+/) || [''])[0])
              : null;
          const ageValid =
            age === null || (Number.isFinite(age) && age >= 18 && age <= 100);
          if (!name || /^name$|^director$/i.test(name) || !ageValid) continue;
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
                  .split(/;|,(?![^()]*\))/)
                  .map((s) => s.replace(/\s+/g, ' ').trim().replace(/[.;]$/, ''))
                  .filter((s) => s.length > 2 && /^[A-Z]/.test(s) && !/committee|none\b/i.test(s))
              : [];
          out.push({
            name,
            age,
            since,
            committees,
            otherBoards: [...new Set(otherBoards)],
          });
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
  const HEAD = new RegExp(
    `(${TOKEN}(?:\\s+(?:[A-Z]\\.|${TOKEN})){1,3})` +
      `(?:,\\s*age\\s*(\\d{2})|,\\s*(\\d{2})(?=\\s*,)|\\s*\\(age\\s*(\\d{2})\\))`,
    'g'
  );
  const heads = [];
  let m;
  while ((m = HEAD.exec(txt)) !== null) {
    heads.push({ name: m[1].trim(), age: Number(m[2] ?? m[3] ?? m[4]), at: m.index });
  }
  return heads
    .map((hd, i) => {
      const w = txt.slice(hd.at, i + 1 < heads.length ? heads[i + 1].at : txt.length);
      const since = (w.match(/(?:director since|since)\s+(?:[A-Za-z]+\s+){0,2}(?:\d{1,2},?\s*)?((?:19|20)\d{2})/i) || [])[1];
      return {
        name: hd.name,
        age: hd.age,
        since: since ? Number(since) : null,
        committees: COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(w)),
        otherBoards: [],
      };
    })
    .filter((d) => {
      const personName = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4}$/.test(d.name)
        && !/\b(table|date|page|exhibit|item|note|index|contents)\b/i.test(d.name);
      const ageOk = Number.isFinite(d.age) && d.age >= 18 && d.age <= 100;
      const sinceOk = Number.isFinite(d.since) && d.since >= 1900 && d.since <= 2100;
      return personName && (ageOk || sinceOk);
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

// Some proxies (e.g. AMZN) inject a "$" separator cell between the header
// column and the numeric value, so the value sits at headerCol+1 or +2.
// Scan up to 3 positions rightward from the header index to find the first
// non-null numeric; never skip past the next labelled column.
function numFromCol(row, colIdx, nextColIdx) {
  if (colIdx === undefined) return null;
  const limit = nextColIdx !== undefined ? Math.min(colIdx + 3, nextColIdx) : colIdx + 3;
  for (let i = colIdx; i <= limit && i < row.length; i++) {
    const v = toNum(row[i]);
    if (v != null) return v;
  }
  return null;
}

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
//
// Some proxies (e.g. KO) split column labels across 2–3 header rows:
// one row carries "Salary | Bonus | ... | Total", the adjacent row
// carries "Name and Principal Position | Year | ($) | ($) | ...".
// SCT_SIG_SINGLE handles the single-row case (most issuers); the
// multi-row fallback below merges consecutive rows and maps headers
// from the merged view.
const SCT_SIG_SINGLE = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  return (
    /salary/.test(j) &&
    /\btotal\b/.test(j) &&
    /name|principal position/.test(j) &&
    [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 1
  );
};

// Sliding-window version: returns the index of the first row in a
// window of up to `win` rows (default 4) whose UNION satisfies the
// full SCT signature. Returns { hIdx, merged } where merged is the
// flattened header array and hIdx is the last header row index
// (data starts at hIdx+1).
function findSctHeaderWindow(all, win = 4) {
  for (let start = 0; start < all.length - 1; start++) {
    // Build a merged row from start..start+win-1
    for (let end = start + 1; end < Math.min(start + win, all.length); end++) {
      const merged = [];
      for (let r = start; r <= end; r++) {
        all[r].forEach((v, i) => {
          if (v && v.trim() && v !== '​') merged[i] = (merged[i] ? merged[i] + ' ' : '') + v;
        });
      }
      const j = merged.join(' | ').toLowerCase();
      if (
        /salary/.test(j) &&
        /\btotal\b/.test(j) &&
        /name|principal position/.test(j) &&
        [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 1
      ) {
        return { hIdx: end, merged };
      }
    }
  }
  return null;
}

export function parseComp(html) {
  const root = parseHtml(html);

  // Primary path: single-row header (AAPL, AMZN, most issuers).
  let table = findTableBySignature(root, SCT_SIG_SINGLE);
  let all = table ? tableRows(table) : [];
  let hIdx = table ? all.findIndex((cells) => SCT_SIG_SINGLE(cells)) : -1;
  let h = hIdx >= 0 ? headerMap(all[hIdx]) : {};

  // Fallback: multi-row header (KO). Try every table; pick the last
  // one with a valid window match (same deepest-wins logic as
  // findTableBySignature).
  if (!table || hIdx < 0 || h.name === undefined || h.total === undefined) {
    let bestTable = null;
    let bestResult = null;
    for (const t of root.querySelectorAll('table')) {
      const rows = tableRows(t);
      const result = findSctHeaderWindow(rows);
      if (result) { bestTable = t; bestResult = result; }
    }
    if (bestTable && bestResult) {
      table = bestTable;
      all = tableRows(table);
      hIdx = bestResult.hIdx;
      h = headerMap(bestResult.merged);
    }
  }

  if (!table || hIdx < 0) return { rows: [] };
  if (h.name === undefined || h.total === undefined) return { rows: [] };
  if (h.name === undefined || h.total === undefined) return { rows: [] };

  // Sorted column positions so numFromCol can bound its rightward scan.
  const colOrder = Object.values(h).filter(Number.isFinite).sort((a, b) => a - b);
  const nextCol = (idx) => colOrder.find((pos) => pos > idx);

  const rows = [];
  const seen = new Set();
  for (let i = hIdx + 1; i < all.length; i++) {
    const c = all[i];
    // Name is always text at h.name directly; numeric scan is for dollar columns.
    const nameTxt = (c[h.name] || '').trim();
    if (!nameTxt || /^name|director|^total$/i.test(nameTxt)) continue;
    const total = numFromCol(c, h.total, nextCol(h.total));
    if (!total) continue;
    const { name, title } = splitNameTitle(nameTxt);
    if (!name || seen.has(name)) continue; // first (latest year) row per officer
    seen.add(name);
    const salary = h.salary !== undefined ? numFromCol(c, h.salary, nextCol(h.salary)) : null;
    const stock = h.stock !== undefined ? numFromCol(c, h.stock, nextCol(h.stock)) : null;
    const option = h.option !== undefined ? numFromCol(c, h.option, nextCol(h.option)) : null;
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
