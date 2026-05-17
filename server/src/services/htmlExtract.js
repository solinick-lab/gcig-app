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

// Direct rows/cells only — SEC wraps data tables in layout tables, and
// querySelectorAll descends into them; nested rows would scramble the
// header/column mapping.
export function tableRows(table) {
  if (!table) return [];
  const directTrs = table.querySelectorAll('tr').filter((tr) => {
    const p = tr.parentNode;
    if (p === table) return true;
    const pt = p && String(p.tagName || '').toLowerCase();
    return !!p && /^(tbody|thead|tfoot)$/.test(pt || '') && p.parentNode === table;
  });
  return directTrs.map((tr) =>
    tr.querySelectorAll('th,td')
      .filter((c) => c.parentNode === tr)
      .map((c) => cellText(c))
  );
}

// Returns the INNERMOST <table> whose any (direct) row satisfies
// `predicate`. node-html-parser yields tables in document (pre-)order,
// so a wrapping layout table appears before the real data table; we
// keep the last match = the deepest. Callers SHOULD include a name/
// principal-position discriminator in `predicate` so a table-of-
// contents or narrative table can't false-positive.
export function findTableBySignature(root, predicate) {
  if (!root) return null;
  let best = null;
  for (const t of root.querySelectorAll('table')) {
    const rows = tableRows(t);
    if (rows.some((cells) => { try { return predicate(cells); } catch { return false; } })) {
      best = t;
    }
  }
  return best;
}

// Given a header row (array of cell text), map logical column → index by
// loose label match. Returns { name, year, salary, bonus, stock,
// option, nonequity, total, age, since, committees, otherboards } with
// any found index (others undefined).
const COL_PATTERNS = {
  name: /^name\b|principal position|^director$|^nominee$/i,
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

const BLOCK_LEAF = /^(p|li|td|th|dt|dd|caption)$/;

// Text after the first heading-ish node matching `re`, up to the next
// heading-ish node. Emits only block-leaf elements (or a div/span with
// no block children) so the same text isn't repeated once per ancestor.
export function locateSectionText(root, re) {
  if (!root) return '';
  const HEAD = /^h[1-6]$/;
  const nodes = root.querySelectorAll('*');
  let startIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish =
      HEAD.test(tag) ||
      ((tag === 'b' || tag === 'strong' || tag === 'p') && txt.length <= 90);
    if (headish && re.test(txt)) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  const parts = [];
  for (let i = startIdx + 1; i < nodes.length; i++) {
    const n = nodes[i];
    const tag = String(n.tagName || '').toLowerCase();
    const txt = cellText(n);
    const headish =
      HEAD.test(tag) ||
      ((tag === 'b' || tag === 'strong') &&
        txt.length <= 90 &&
        /officers|directors|compensation|proposal|ownership/i.test(txt));
    if (headish && i > startIdx + 1) break;
    const isLeafBlock = BLOCK_LEAF.test(tag);
    const isDivLike = /^(div|section|span)$/.test(tag);
    const hasBlockChild =
      isDivLike &&
      n.childNodes &&
      n.childNodes.some(
        (c) =>
          c.nodeType === 1 &&
          /^(p|div|li|table|h[1-6])$/.test(String(c.tagName || '').toLowerCase())
      );
    if ((isLeafBlock || (isDivLike && !hasBlockChild)) && txt) parts.push(txt);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
