// MGMT parsers. Each takes proxyStatement sections (plain text) and
// returns structured, per-field-nullable data. Pure, never throws.
// DEF 14A prose is irregular; these favor recall and return null for
// anything they can't confidently extract — the panel shows "—".

const TITLES = [
  'Chief Executive Officer', 'Chief Financial Officer', 'Chief Operating Officer',
  'President', 'Chief Technology Officer', 'Chief Accounting Officer',
  'General Counsel', 'Chief Legal Officer', 'Executive Chairman',
];
const TITLE_RE = new RegExp(`(${TITLES.join('|')})`, 'i');

// "Jane A. Doe, 54, has served as Chief Executive Officer since 2018"
// Name pattern: first token is a capitalized word (mixed case, no trailing
// period — rules out abbreviated entities like "Corp."); subsequent tokens
// may be a single capital initial ("A.") or another capitalized word.
// This combination excludes all-caps section headers like "OFFICERS" and
// cross-sentence collisions like "Corp. John B. Smith".
// The sentence pattern after the title is greedy up to the period so
// "since YYYY" is captured when present; the group is optional for
// officers whose bio omits the start year.
const EXEC_RE =
  /([A-Z][a-z][a-zA-Z'-]*(?:\s+(?:[A-Z]\.|[A-Z][a-z][a-zA-Z'-]*))+),\s*(\d{2}),[^.]*?\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\b(?:[^.]*?since\s*(\d{4})|[^.]*)/g;

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
  const re = /\b(?:Prior(?:\sto)?|Previously|formerly)\b[^.]*?\b(President|Chief [A-Za-z ]+Officer|Partner|Director)\b[^.]*?\bof\s+([A-Z][A-Za-z.,& ]{2,40}?)[.,]/g;
  let r;
  while ((r = re.exec(after)) !== null && out.length < 3) {
    out.push(`${r[1].trim()}, ${r[2].trim()}`);
  }
  return out;
}
