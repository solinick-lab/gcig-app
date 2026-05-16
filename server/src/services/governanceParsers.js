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

const COMMITTEES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

// One director "record" is the text from their name+age up to the next
// "<Name>, age NN" or end. We then mine that window for since /
// committees / other boards.
const DIR_HEAD_RE = new RegExp(
  `(${TOKEN}(?:\\s+${TOKEN}){1,3}),\\s*age\\s*(\\d{2})`,
  'g',
);

export function parseBoard(sections) {
  const text = sections?.board || '';
  const heads = [];
  let m;
  DIR_HEAD_RE.lastIndex = 0;
  while ((m = DIR_HEAD_RE.exec(text)) !== null) {
    heads.push({ name: m[1].replace(/\s+/g, ' ').trim(), age: Number(m[2]), at: m.index });
  }
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : text.length;
    const w = text.slice(h.at, end);
    const since = (
      w.match(/(?:director since|since)\s+(?:[A-Za-z]+\s+){0,2}(?:\d{1,2},?\s*)?(\d{4})/i) || []
    )[1];
    const committees = COMMITTEES.filter((c) =>
      new RegExp(`${c}\\s+Committee`, 'i').test(w)
    );
    const otherBoards = [];
    const ob =
      /\bboard(?:\sof\sdirectors)?\sof\s+([A-Z][A-Za-z0-9.,&' ]+?)(?:\.|;|\bShe\b|\bHe\b|\bMr\.|\bMs\.|$)/gi;
    let o;
    while ((o = ob.exec(w)) !== null) {
      for (const name of o[1].split(/\band\b|,/)) {
        const n = name.replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
        if (n.length > 2 && /^[A-Z]/.test(n) && !/committee/i.test(n)) otherBoards.push(n);
      }
    }
    return {
      name: h.name,
      age: h.age,
      since: since ? Number(since) : null,
      committees,
      otherBoards: [...new Set(otherBoards)],
    };
  });
}
