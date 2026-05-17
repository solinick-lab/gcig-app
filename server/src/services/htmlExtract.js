// Small pure DOM helpers over node-html-parser, shared by the
// governance parsers. The whole point of the MGMT rebuild: find the
// Summary Compensation Table / director table by their header-cell
// SIGNATURE anywhere in the document, so the table-of-contents and
// cross-references (which broke the old flatten-regex approach) are
// irrelevant. Nothing here throws.
import { parse } from 'node-html-parser';

export function parseHtml(html) {
  try {
    return parse(String(html || ''), { lowerCaseTagName: true });
  } catch {
    return parse('');
  }
}

// Decoded, tag-stripped, whitespace-collapsed text of a node.
export function cellText(node) {
  if (!node) return '';
  return String(node.text || '').replace(/\s+/g, ' ').trim();
}

// All rows of a table as arrays of cell text (th or td).
export function tableRows(table) {
  if (!table) return [];
  return table.querySelectorAll('tr').map((tr) =>
    tr.querySelectorAll('th,td').map((c) => cellText(c))
  );
}

// First <table> whose ANY row's cell-text array satisfies `predicate`.
// (SCT/board header rows sometimes use <td>, and may be the 2nd row
// under a group-header row — so we test every row, not just the first.)
export function findTableBySignature(root, predicate) {
  if (!root) return null;
  for (const t of root.querySelectorAll('table')) {
    const rows = tableRows(t);
    if (rows.some((cells) => { try { return predicate(cells); } catch { return false; } })) {
      return t;
    }
  }
  return null;
}

// Given a header row (array of cell text), map logical column → index by
// loose label match. Returns { name, year, salary, bonus, stock,
// option, nonequity, total, age, since, committees, otherboards } with
// any found index (others undefined).
const COL_PATTERNS = {
  name: /name|principal position|director|nominee/i,
  year: /^year$/i,
  salary: /salary/i,
  bonus: /^bonus/i,
  stock: /stock award/i,
  option: /option award/i,
  nonequity: /non-?equity/i,
  total: /^total/i,
  age: /^age$/i,
  since: /director since|^since$|since\b/i,
  committees: /committee/i,
  otherboards: /other.*(public|director|board)|public.*director/i,
};
export function headerMap(headerCells) {
  const out = {};
  (headerCells || []).forEach((txt, i) => {
    for (const [key, re] of Object.entries(COL_PATTERNS)) {
      if (out[key] === undefined && re.test(txt)) out[key] = i;
    }
  });
  return out;
}

// Text content that follows the first heading-ish node matching `re`,
// up to the next heading-ish node. Heading-ish = h1..h6, or a <b>/
// <strong>/<p> whose entire text is short and matches. Best-effort.
export function locateSectionText(root, re) {
  if (!root) return '';
  const HEAD = /^h[1-6]$/;
  const nodes = root.querySelectorAll('*');
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish = HEAD.test(tag) || ((tag === 'b' || tag === 'strong' || tag === 'p') && txt.length <= 90);
    if (headish && re.test(txt)) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  const parts = [];
  for (let i = startIdx + 1; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish = HEAD.test(tag) || ((tag === 'b' || tag === 'strong') && txt.length <= 90 && /officers|directors|compensation|proposal|ownership/i.test(txt));
    if (headish && i > startIdx + 1) break;
    if (txt) parts.push(txt);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
