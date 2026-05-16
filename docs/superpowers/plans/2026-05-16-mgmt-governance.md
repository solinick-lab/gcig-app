# MGMT Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `MGMT`, a ticker-scoped terminal panel showing a company's CEO/executives, board of directors, compensation mix, and an interlocking-board network — all parsed from its latest SEC DEF 14A proxy.

**Architecture:** One never-throws `proxyStatement.js` service (ticker→CIK→newest DEF 14A→primary HTML→plain text→named sections, 24h cache) feeds four pure parser functions in `governanceParsers.js` (`parseLeadership`, `parseBoard`, `parseComp`, `buildNetwork`). One auth-gated route returns the combined payload; a tabbed React panel renders it.

**Tech Stack:** Node ESM, `node:test`/`node:assert/strict`, existing `services/secFilings.js` (CIK lookup) + `services/sheetPortfolio.js` (holdings), Express `routes/terminal.js`, React + existing terminal panel patterns, Vite build for client verification. No new dependencies (dependency-free HTML→text).

---

## File Structure

- **Create** `server/src/services/proxyStatement.js` — the spine: locate newest DEF 14A, fetch primary doc, `htmlToText`, `splitSections`, cache, `getProxyStatement`. Never throws.
- **Create** `server/src/services/proxyStatement.test.js`
- **Create** `server/src/services/governanceParsers.js` — four pure exports: `parseLeadership`, `parseBoard`, `parseComp`, `buildNetwork`. Pure (text in → nullable structured out), never throw.
- **Create** `server/src/services/governanceParsers.test.js`
- **Modify** `server/src/routes/terminal.js` — `MGMT` in `KNOWN_FUNCTIONS`; `GET /api/terminal/governance/:ticker`.
- **Create** `client/src/terminal/functions/Governance.jsx` — tabbed panel.
- **Modify** `client/src/terminal/registry.js` — register `MGMT`.
- **Modify** `client/src/terminal/theme.css` — minimal scoped tab styles.

Conventions: server tests colocated `*.test.js`, run by `node --test`. Services follow the never-throws/best-effort contract of `services/worldIndices.js` and `services/insiderTx.js`. Editorial comments (why, not what). Client verification = `npm run build` (no client test runner).

---

## Task 1: Spine — locate the newest DEF 14A

**Files:**
- Create: `server/src/services/proxyStatement.js`
- Test: `server/src/services/proxyStatement.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/proxyStatement.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLatestDef14A } from './proxyStatement.js';

const FILINGS = [
  { accessionNumber: '0000000000-26-000002', form: 'DEFA14A', filingDate: '2026-04-02', primaryDocument: 'extra.htm', url: 'https://x/extra.htm' },
  { accessionNumber: '0000000000-26-000001', form: 'DEF 14A', filingDate: '2026-03-15', primaryDocument: 'proxy2026.htm', url: 'https://x/xslF/proxy2026.htm' },
  { accessionNumber: '0000000000-25-000001', form: 'DEF 14A', filingDate: '2025-03-10', primaryDocument: 'proxy2025.htm', url: 'https://x/proxy2025.htm' },
  { accessionNumber: '0000000000-26-000009', form: '4', filingDate: '2026-05-01', primaryDocument: 'f4.xml', url: 'https://x/f4.xml' },
];

test('pickLatestDef14A picks the newest DEF 14A (never DEFA14A), strips xsl viewer', () => {
  const f = pickLatestDef14A(FILINGS);
  assert.equal(f.filingDate, '2026-03-15');
  assert.equal(f.url, 'https://x/proxy2026.htm'); // /xslF/ stripped
});

test('pickLatestDef14A returns null when no DEF 14A present', () => {
  assert.equal(pickLatestDef14A(FILINGS.filter((x) => x.form !== 'DEF 14A')), null);
  assert.equal(pickLatestDef14A([]), null);
  assert.equal(pickLatestDef14A(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/proxyStatement.js`:

```js
// MGMT spine. Everything in MGMT derives from one document: the
// company's latest DEF 14A proxy. We locate it via the same SEC
// submissions feed secFilings.js already uses, fetch the primary HTML,
// flatten to text, and split into the named sections the parsers want.
// Best-effort and never throws — a missing proxy or section yields
// null, never an error (same contract as services/worldIndices.js).
import { getRecentFilings } from './secFilings.js';

// SEC hands back the XSL viewer URL (.../xslF…/doc.htm → HTML wrapper).
// The raw primary document sits at the same path without that segment.
function toRawUrl(url) {
  return String(url || '').replace(/\/xsl[^/]+\//, '/');
}

// DEFA14A is supplementary soliciting material and usually lacks the
// bio/comp tables — never fall back to it. Newest DEF 14A only.
export function pickLatestDef14A(filings) {
  if (!Array.isArray(filings)) return null;
  const def = filings
    .filter((f) => f && String(f.form) === 'DEF 14A' && f.url)
    .sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
  if (def.length === 0) return null;
  return { ...def[0], url: toRawUrl(def[0].url) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/proxyStatement.js server/src/services/proxyStatement.test.js
git commit -m "feat(mgmt): locate newest DEF 14A (never DEFA14A)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Spine — HTML→text + section split + cached orchestrator

**Files:**
- Modify: `server/src/services/proxyStatement.js`
- Test: `server/src/services/proxyStatement.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { htmlToText, splitSections, getProxyStatement, _resetProxyCache } from './proxyStatement.js';

test('htmlToText strips tags, decodes entities, collapses space', () => {
  const t = htmlToText('<div>Board&nbsp;of <b>Directors</b></div><p>Jane&amp;Co</p><script>x()</script>');
  assert.equal(t, 'Board of Directors Jane&Co');
});

test('splitSections buckets text by heading keywords', () => {
  const text =
    'ELECTION OF DIRECTORS Jane Doe age 55 director since 2019. ' +
    'DIRECTOR COMPENSATION fees earned 100000. ' +
    'EXECUTIVE OFFICERS John Smith President. ' +
    'SUMMARY COMPENSATION TABLE Salary Bonus Stock Awards.';
  const s = splitSections(text);
  assert.match(s.board, /Jane Doe age 55/);
  assert.match(s.execBios, /John Smith President/);
  assert.match(s.comp, /Salary Bonus Stock Awards/);
});

test('getProxyStatement returns stub when no DEF 14A (never throws)', async () => {
  _resetProxyCache();
  const r = await getProxyStatement('NOPE', {
    filingsFetch: async () => [],
  });
  assert.equal(r._source, null);
  assert.deepEqual(r.sections, {});
});

test('getProxyStatement parses + caches a found proxy', async () => {
  _resetProxyCache();
  let docCalls = 0;
  const opts = {
    filingsFetch: async () => [
      { form: 'DEF 14A', filingDate: '2026-03-15', url: 'https://x/p.htm' },
    ],
    docFetch: async () => {
      docCalls++;
      return '<h1>ELECTION OF DIRECTORS</h1><p>Jane Doe age 55</p>';
    },
  };
  const a = await getProxyStatement('AAA', opts);
  const b = await getProxyStatement('AAA', opts);
  assert.equal(a._source, 'sec');
  assert.match(a.sections.board, /Jane Doe age 55/);
  assert.equal(docCalls, 1); // cached on second call
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: FAIL — `htmlToText`/`splitSections`/`getProxyStatement`/`_resetProxyCache` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `proxyStatement.js`)

```js
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'", '&quot;': '"', '&apos;': "'" };

// Dependency-free: drop script/style, strip tags, decode the handful of
// entities SEC proxies actually use, collapse whitespace. Good enough
// for keyword section-splitting and line/number extraction.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#\d+;|&[a-z]+;/gi, (m) => (ENTITIES[m.toLowerCase()] ?? ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// Heading keywords → section bucket. We scan for the first occurrence
// of each anchor and slice from it to the next anchor. Recall over
// precision: a section we cannot find is simply null.
const ANCHORS = [
  { key: 'board', re: /\bELECTION OF DIRECTORS\b|\bNOMINEES? FOR DIRECTOR\b|\bBOARD OF DIRECTORS\b/i },
  { key: 'dirComp', re: /\bDIRECTOR COMPENSATION\b/i },
  { key: 'execBios', re: /\bEXECUTIVE OFFICERS\b|\bINFORMATION ABOUT (OUR )?EXECUTIVE OFFICERS\b/i },
  { key: 'comp', re: /\bSUMMARY COMPENSATION TABLE\b/i },
];

export function splitSections(text) {
  const t = String(text || '');
  const hits = [];
  for (const a of ANCHORS) {
    const m = a.re.exec(t);
    if (m) hits.push({ key: a.key, at: m.index });
  }
  hits.sort((x, y) => x.at - y.at);
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].at : t.length;
    out[hits[i].key] = t.slice(hits[i].at, end).trim();
  }
  return out;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
export function _resetProxyCache() {
  cache.clear();
}

async function defaultFilingsFetch(ticker) {
  return getRecentFilings(ticker, { limit: 25 });
}
async function defaultDocFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
  if (!r.ok) throw new Error(`sec doc ${r.status}`);
  return r.text();
}

// { ticker, filedAt, url, sections, _source }. Never throws.
export async function getProxyStatement(ticker, deps = {}) {
  const sym = String(ticker || '').toUpperCase();
  const empty = { ticker: sym, filedAt: null, url: null, sections: {}, _source: null };
  if (!sym) return empty;

  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;

  const filingsFetch = deps.filingsFetch || defaultFilingsFetch;
  const docFetch = deps.docFetch || defaultDocFetch;

  let payload = empty;
  try {
    const filing = pickLatestDef14A(await filingsFetch(sym));
    if (filing) {
      const html = await docFetch(filing.url);
      payload = {
        ticker: sym,
        filedAt: filing.filingDate || null,
        url: filing.url,
        sections: splitSections(htmlToText(html)),
        _source: 'sec',
      };
    }
  } catch (err) {
    console.warn(`proxyStatement(${sym}) failed:`, err.message);
    payload = empty;
  }

  cache.set(sym, { at: Date.now(), payload });
  return payload;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/proxyStatement.test.js`
Expected: PASS — all Task 1 + Task 2 tests.

- [ ] **Step 5: Run full server suite (no regressions)**

Run: `cd server && npm test`
Expected: PASS (existing suites + proxyStatement).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/proxyStatement.js server/src/services/proxyStatement.test.js
git commit -m "feat(mgmt): proxy fetch, html->text, section split, 24h cache

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `parseLeadership`

**Files:**
- Create: `server/src/services/governanceParsers.js`
- Test: `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/src/services/governanceParsers.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadership } from './governanceParsers.js';

const SECTIONS = {
  execBios:
    'EXECUTIVE OFFICERS Jane A. Doe, 54, has served as Chief Executive Officer ' +
    'since 2018. Prior to joining the Company, Ms. Doe was President of Acme Corp. ' +
    'John B. Smith, 47, has served as Chief Financial Officer since 2021.',
};

test('parseLeadership extracts CEO and execs with age/since', () => {
  const { ceo, execs } = parseLeadership(SECTIONS);
  assert.equal(ceo.name, 'Jane A. Doe');
  assert.equal(ceo.title, 'Chief Executive Officer');
  assert.equal(ceo.age, 54);
  assert.equal(ceo.since, 2018);
  assert.ok(execs.some((e) => e.name === 'John B. Smith' && e.title === 'Chief Financial Officer'));
});

test('parseLeadership degrades to nulls on missing section', () => {
  const r = parseLeadership({});
  assert.equal(r.ceo, null);
  assert.deepEqual(r.execs, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/services/governanceParsers.js`:

```js
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
const EXEC_RE =
  /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}),\s*(\d{2}),[^.]*?\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\b[^.]*?(?:since\s*(\d{4}))?/g;

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
      totalComp: null, // filled by parseComp join in the route
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
```

(`TITLE_RE` is exported-adjacent shared state used by later parsers; keep it in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): parseLeadership (CEO + execs from proxy bios)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `parseBoard`

**Files:**
- Modify: `server/src/services/governanceParsers.js`
- Test: `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { parseBoard } from './governanceParsers.js';

const BOARD_SECTION = {
  board:
    'ELECTION OF DIRECTORS ' +
    'Maria Lopez, age 61, has been a director since 2015. Ms. Lopez also serves ' +
    'on the board of directors of Globex Corporation and Initech Inc. ' +
    'She is a member of the Audit Committee and Compensation Committee. ' +
    'David Chen, age 58, director since 2020. Mr. Chen serves on the board of ' +
    'Soylent Corp. He chairs the Nominating Committee.',
};

test('parseBoard extracts directors with age, since, committees, other boards', () => {
  const board = parseBoard(BOARD_SECTION);
  const maria = board.find((d) => d.name === 'Maria Lopez');
  assert.equal(maria.age, 61);
  assert.equal(maria.since, 2015);
  assert.deepEqual(maria.otherBoards.sort(), ['Globex Corporation', 'Initech Inc'].sort());
  assert.ok(maria.committees.includes('Audit'));
  const david = board.find((d) => d.name === 'David Chen');
  assert.deepEqual(david.otherBoards, ['Soylent Corp']);
});

test('parseBoard returns [] on missing section', () => {
  assert.deepEqual(parseBoard({}), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: FAIL — `parseBoard` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `governanceParsers.js`)

```js
const COMMITTEES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

// One director "record" is the text from their name+age up to the next
// "<Name>, age NN" or end. We then mine that window for since /
// committees / other boards.
const DIR_HEAD_RE = /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3}),\s*age\s*(\d{2})/g;

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
    const since = (w.match(/(?:director since|since)\s*(\d{4})/i) || [])[1];
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
        if (n.length > 2 && !/committee/i.test(n)) otherBoards.push(n);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: PASS — Task 3 + Task 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): parseBoard (directors, age, tenure, committees, other boards)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `parseComp`

**Files:**
- Modify: `server/src/services/governanceParsers.js`
- Test: `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { parseComp } from './governanceParsers.js';

const COMP_SECTION = {
  comp:
    'SUMMARY COMPENSATION TABLE ' +
    'Jane A. Doe Chief Executive Officer 2025 1,000,000 0 5,000,000 3,000,000 1,000,000 10,000,000 ' +
    'John B. Smith Chief Financial Officer 2025 600,000 0 1,400,000 0 0 2,000,000',
};

test('parseComp derives pay-mix percentages from the SCT', () => {
  const { rows } = parseComp(COMP_SECTION);
  const jane = rows.find((r) => /Jane A\. Doe/.test(r.name));
  assert.equal(jane.total, 10000000);
  assert.equal(jane.salaryPct, 10);   // 1,000,000 / 10,000,000
  assert.equal(jane.stockPct, 50);    // 5,000,000 / 10,000,000
  assert.equal(jane.optionPct, 30);   // 3,000,000 / 10,000,000
});

test('parseComp returns empty rows on missing section', () => {
  assert.deepEqual(parseComp({}), { rows: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: FAIL — `parseComp` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `governanceParsers.js`)

```js
const NUM = (s) => Number(String(s).replace(/[,$]/g, ''));

// SCT canonical column order: Salary, Bonus, Stock, Option, (Non-equity
// + change + other collapsed), Total. We read the named-officer row as:
// <Name> <Title> <Year> n1 n2 n3 n4 n5 ... <Total = last/largest>.
// Robust to extra trailing columns by treating the LAST number as Total.
const COMP_ROW_RE =
  /([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){1,3})\s+(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\s+(\d{4})\s+([\d,]+(?:\s+[\d,]+){3,7})/g;

export function parseComp(sections) {
  const text = sections?.comp || '';
  const rows = [];
  let m;
  COMP_ROW_RE.lastIndex = 0;
  while ((m = COMP_ROW_RE.exec(text)) !== null) {
    const nums = m[4].trim().split(/\s+/).map(NUM).filter((n) => Number.isFinite(n));
    if (nums.length < 4) continue;
    const total = nums[nums.length - 1];
    if (!total) continue;
    const [salary, , stock, option] = nums;
    const pct = (v) => (v == null ? null : Math.round((v / total) * 100));
    rows.push({
      name: m[1].replace(/\s+/g, ' ').trim(),
      title: m[2].trim(),
      total,
      salaryPct: pct(salary),
      stockPct: pct(stock),
      optionPct: pct(option),
      otherPct: Math.max(
        0,
        100 - [salary, stock, option].reduce((a, v) => a + Math.round(((v || 0) / total) * 100), 0)
      ),
    });
  }
  return { rows };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: PASS — Tasks 3–5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): parseComp (pay mix from Summary Compensation Table)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `buildNetwork` (bounded to fund holdings)

**Files:**
- Modify: `server/src/services/governanceParsers.js`
- Test: `server/src/services/governanceParsers.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { buildNetwork } from './governanceParsers.js';

test('buildNetwork links directors whose other boards are also fund holdings', () => {
  const board = [
    { name: 'Maria Lopez', otherBoards: ['Globex Corporation', 'Initech Inc'] },
    { name: 'David Chen', otherBoards: ['Soylent Corp'] },
  ];
  const holdings = [
    { ticker: 'GLBX', name: 'Globex Corporation' },
    { ticker: 'INIT', name: 'Initech Inc' },
    { ticker: 'AAPL', name: 'Apple Inc' },
  ];
  const n = buildNetwork('FOCUS', board, holdings);
  // Maria connects FOCUS to GLBX and INIT; David's Soylent is not held.
  const pairs = n.edges.map((e) => `${e.person}|${e.a}|${e.b}`).sort();
  assert.deepEqual(pairs, ['Maria Lopez|FOCUS|GLBX', 'Maria Lopez|FOCUS|INIT'].sort());
  assert.ok(n.nodes.includes('FOCUS') && n.nodes.includes('GLBX'));
});

test('buildNetwork empty when no overlap / bad input', () => {
  assert.deepEqual(buildNetwork('X', [], []), { nodes: [], edges: [] });
  assert.deepEqual(buildNetwork('X', null, null), { nodes: [], edges: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: FAIL — `buildNetwork` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `governanceParsers.js`)

```js
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
      if (tk && tk !== f) {
        nodes.add(f);
        nodes.add(tk);
        edges.push({ person: d.name, a: f, b: tk });
      }
    }
  }
  return { nodes: [...nodes], edges };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && node --test src/services/governanceParsers.test.js`
Expected: PASS — Tasks 3–6 tests.

- [ ] **Step 5: Run full server suite**

Run: `cd server && npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/governanceParsers.js server/src/services/governanceParsers.test.js
git commit -m "feat(mgmt): buildNetwork (interlocking boards, bounded to holdings)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Route + KNOWN_FUNCTIONS

**Files:**
- Modify: `server/src/routes/terminal.js`

- [ ] **Step 1: Add imports** (with the other service imports near the top)

```js
import { getProxyStatement } from '../services/proxyStatement.js';
import { parseLeadership, parseBoard, parseComp, buildNetwork } from '../services/governanceParsers.js';
import { getSheetPortfolio } from '../services/sheetPortfolio.js';
```

(If `getSheetPortfolio` is not the export name in `services/sheetPortfolio.js`, read that file and use its actual holdings export — it must return an array of `{ ticker, name }`-ish rows; adapt the mapping in Step 3 accordingly. Do not invent a new export.)

- [ ] **Step 2: Register MGMT** — add to `KNOWN_FUNCTIONS` immediately after the `INSDR` entry:

```js
  { id: 'MGMT', label: 'Management & Board', summary: 'CEO, executives, board, compensation, and interlocking-board network from the latest DEF 14A.' },
```

- [ ] **Step 3: Add the route** — immediately after the `/insiders/:ticker` handler:

```js
// MGMT — leadership, board, comp and interlocking-board network for a
// ticker, all from its latest DEF 14A. Every section is best-effort
// and independently nullable; an unparseable proxy is a normal 200.
router.get('/governance/:ticker', async (req, res) => {
  const raw = String(req.params.ticker || '').trim().toUpperCase();
  if (!raw || !/^[A-Z0-9.\-]{1,12}$/.test(raw)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }
  try {
    const proxy = await getProxyStatement(raw);
    const { ceo, execs } = parseLeadership(proxy.sections);
    const board = parseBoard(proxy.sections);
    const comp = parseComp(proxy.sections);
    let holdings = [];
    try {
      holdings = await getSheetPortfolio();
    } catch {
      holdings = [];
    }
    const network = buildNetwork(
      raw,
      board,
      (Array.isArray(holdings) ? holdings : []).map((h) => ({
        ticker: h.ticker || h.symbol || '',
        name: h.name || h.company || '',
      }))
    );
    res.json({
      ticker: raw,
      asOf: proxy.filedAt,
      source: proxy._source,
      ceo,
      execs,
      board,
      comp,
      network,
    });
  } catch (err) {
    console.error(`terminal/governance(${raw}) failed:`, err.message);
    res.status(502).json({ error: 'Governance data unavailable' });
  }
});
```

- [ ] **Step 4: Verify**

Run: `cd server && node --check src/routes/terminal.js && npm test`
Expected: `node --check` exit 0; `npm test` all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/terminal.js
git commit -m "feat(mgmt): GET /api/terminal/governance/:ticker + MGMT in KNOWN_FUNCTIONS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Client `MGMT` panel + registry + styles

**Files:**
- Create: `client/src/terminal/functions/Governance.jsx`
- Modify: `client/src/terminal/registry.js`
- Modify: `client/src/terminal/theme.css`

- [ ] **Step 1: Create the panel**

Create `client/src/terminal/functions/Governance.jsx`:

```jsx
import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client.js';

// MGMT — leadership / board / comp / network from the latest DEF 14A.
// Every section is best-effort; missing fields render as "—".

const TABS = ['Leadership', 'Board', 'Comp', 'Network'];
const dash = (v) => (v == null || v === '' ? '—' : v);

export default function Governance({ ticker }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('Leadership');
  const [brief, setBrief] = useState('');
  const [briefLoading, setBriefLoading] = useState(false);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setData(null);
    setBrief('');
    api
      .get(`/terminal/governance/${encodeURIComponent(ticker)}`)
      .then(({ data: d }) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e.response?.data?.error || e.message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  useEffect(() => {
    if (!ticker || !data) return;
    let cancelled = false;
    setBriefLoading(true);
    const ctx = [
      data.ceo ? `CEO: ${data.ceo.name} (${dash(data.ceo.title)}), age ${dash(data.ceo.age)}, since ${dash(data.ceo.since)}` : null,
      `Board: ${(data.board || []).length} directors`,
      (data.comp?.rows || []).map((r) => `${r.name} pay: ${dash(r.salaryPct)}% sal / ${dash(r.stockPct)}% stk / ${dash(r.optionPct)}% opt`).join('; '),
      (data.network?.edges || []).length ? `Shared boards with holdings: ${data.network.edges.map((e) => `${e.person} ${e.a}-${e.b}`).join(', ')}` : null,
    ].filter(Boolean).join('\n');
    api
      .post('/terminal/annotate', { ticker, function: 'MGMT', context: ctx })
      .then(({ data: r }) => { if (!cancelled) setBrief(r.brief || ''); })
      .catch(() => { if (!cancelled) setBrief(''); })
      .finally(() => { if (!cancelled) setBriefLoading(false); });
    return () => { cancelled = true; };
  }, [data, ticker]);

  if (!ticker) return <div className="term-panel"><div className="term-loading">Enter a ticker to load governance.</div></div>;
  if (loading) return <div className="term-panel"><div className="term-loading">Loading DEF 14A…</div></div>;
  if (err) return <div className="term-panel"><div className="term-error">Error: {err}</div></div>;
  if (!data) return null;

  const noProxy = data.source == null;

  return (
    <div className="term-panel" style={{ height: '100%' }}>
      <div className="term-panel-header">
        <span className="ticker">{ticker.toUpperCase()}</span>
        <span className="name">Management &amp; Board</span>
        {data.asOf && <span style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>DEF 14A {data.asOf}</span>}
      </div>

      <div className={`term-ai-block${briefLoading ? ' loading' : ''}`}>
        <span className="label">◢ AI BRIEF</span>
        {briefLoading ? 'Generating…' : brief || 'No brief available.'}
      </div>

      {noProxy ? (
        <div className="term-loading">No recent DEF 14A on file for {ticker.toUpperCase()}.</div>
      ) : (
        <>
          <div className="term-tabs">
            {TABS.map((t) => (
              <button
                key={t}
                className={`term-tab${tab === t ? ' active' : ''}`}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'Leadership' && (
            <div>
              {data.ceo && (
                <div style={{ marginBottom: 8 }}>
                  <div className="sym" style={{ fontSize: 13 }}>{data.ceo.name} · {dash(data.ceo.title)}</div>
                  <div style={{ color: 'var(--term-fg-dim)', fontSize: 11 }}>
                    age {dash(data.ceo.age)} · since {dash(data.ceo.since)}
                    {data.ceo.priorRoles?.length ? ` · prior: ${data.ceo.priorRoles.join('; ')}` : ''}
                  </div>
                </div>
              )}
              <table className="term-table">
                <thead><tr><th>Executive</th><th>Title</th><th className="num">Age</th><th className="num">Since</th></tr></thead>
                <tbody>
                  {(data.execs || []).map((e, i) => (
                    <tr key={i}><td className="sym">{e.name}</td><td>{dash(e.title)}</td><td className="num">{dash(e.age)}</td><td className="num">{dash(e.since)}</td></tr>
                  ))}
                </tbody>
              </table>
              {(data.execs || []).length === 0 && <div className="term-loading">No executive bios parsed.</div>}
            </div>
          )}

          {tab === 'Board' && (
            <table className="term-table">
              <thead><tr><th>Director</th><th className="num">Age</th><th className="num">Since</th><th>Committees</th><th>Other public boards</th></tr></thead>
              <tbody>
                {(data.board || []).map((d, i) => (
                  <tr key={i}>
                    <td className="sym">{d.name}</td>
                    <td className="num">{dash(d.age)}</td>
                    <td className="num">{dash(d.since)}</td>
                    <td>{d.committees?.length ? d.committees.join(', ') : '—'}</td>
                    <td>{d.otherBoards?.length ? d.otherBoards.join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'Comp' && (
            <table className="term-table">
              <thead><tr><th>Name</th><th className="num">Salary%</th><th className="num">Stock%</th><th className="num">Option%</th><th className="num">Other%</th><th className="num">Total</th></tr></thead>
              <tbody>
                {(data.comp?.rows || []).map((r, i) => (
                  <tr key={i}>
                    <td className="sym">{r.name}</td>
                    <td className="num">{dash(r.salaryPct)}</td>
                    <td className="num">{dash(r.stockPct)}</td>
                    <td className="num">{dash(r.optionPct)}</td>
                    <td className="num">{dash(r.otherPct)}</td>
                    <td className="num">{r.total == null ? '—' : `$${Number(r.total).toLocaleString()}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'Network' && (
            (data.network?.edges || []).length === 0 ? (
              <div className="term-loading">No shared boards among current fund holdings.</div>
            ) : (
              <table className="term-table">
                <thead><tr><th>Director</th><th>Focus</th><th>Also on (held)</th></tr></thead>
                <tbody>
                  {data.network.edges.map((e, i) => (
                    <tr key={i}><td className="sym">{e.person}</td><td>{e.a}</td><td className="num">{e.b}</td></tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </>
      )}

      <div style={{ color: 'var(--term-fg-muted)', fontSize: 11 }}>
        Parsed best-effort from the latest DEF 14A · fields may be partial for some filers.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register MGMT** — in `client/src/terminal/registry.js` add the import beside the others:

```js
import Governance from './functions/Governance.jsx';
```

and the entry immediately after the `INSDR` entry in `FUNCTIONS`:

```js
  { id: 'MGMT', label: 'Management & Board', help: 'CEO, board, comp & interlocking boards from the latest DEF 14A.', requires: 'ticker', component: Governance },
```

- [ ] **Step 3: Add tab styles** — append to `client/src/terminal/theme.css` immediately before the `/* BI (chat) panel */` block:

```css
/* MGMT — tab strip */
[data-theme='terminal'] .term-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--term-border);
}
[data-theme='terminal'] .term-tab {
  background: transparent;
  color: var(--term-fg-dim);
  border: 1px solid var(--term-border);
  border-bottom: none;
  font: inherit;
  font-size: 11px;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  cursor: pointer;
}
[data-theme='terminal'] .term-tab.active {
  background: var(--term-fg);
  color: #000;
  font-weight: 700;
}
```

- [ ] **Step 4: Verify the client builds**

Run: `cd client && npm run build`
Expected: `✓ built`, no JSX/import errors (pre-existing chunk/dynamic-import warnings OK).

- [ ] **Step 5: Commit**

```bash
git add client/src/terminal/functions/Governance.jsx client/src/terminal/registry.js client/src/terminal/theme.css
git commit -m "feat(mgmt): MGMT panel — leadership/board/comp/network tabs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Integration verification

**Files:** none (verification + honest reporting)

- [ ] **Step 1:** `cd server && npm test` → all suites pass.
- [ ] **Step 2:** `cd server && node --check src/routes/terminal.js src/services/proxyStatement.js src/services/governanceParsers.js` → exit 0.
- [ ] **Step 3:** Live spine smoke (no key needed):
```bash
cd server && node -e "import('./src/services/proxyStatement.js').then(async m=>{const p=await m.getProxyStatement('AAPL');console.log(JSON.stringify({src:p._source,filedAt:p.filedAt,sections:Object.keys(p.sections)}))})"
```
Report raw output. Honest: `src:"sec"` + section keys → spine works; `src:null` → SEC throttled this run (note it; parsers still unit-verified). Do NOT claim end-to-end parser accuracy from one filer — state coverage is best-effort.
- [ ] **Step 4:** `cd client && npm run build` → `✓ built`.
- [ ] **Step 5:** Record honest status: which sections parsed for the smoke ticker, which were blank, and that real-world DEF 14A variance means partial fields for some filers (no faked completeness).

---

## Self-Review

**1. Spec coverage:**
- DEF 14A spine, CIK reuse, newest DEF 14A only (not DEFA14A), raw-URL, 24h cache, never-throws → Tasks 1–2. ✓
- Leadership (CEO+execs: bio/title/age/since/prior roles) → Task 3. ✓
- Board (age/tenure/committees/other directorships) → Task 4. ✓
- Comp (% salary/stock/option/other from SCT) → Task 5. ✓
- Network (interlocking boards bounded to fund holdings via sheetPortfolio) → Task 6. ✓
- Route `/governance/:ticker`, MGMT in KNOWN_FUNCTIONS, auth/regex/502 → Task 7. ✓
- Tabbed MGMT panel, registry, AI brief, honest "partial" note, no-proxy state → Task 8. ✓
- Honest verification incl. SEC-throttle caveat → Task 9. ✓
- `totalComp` join: `parseLeadership` sets `totalComp:null`; the route returns `comp.rows` separately and the panel shows comp in its own tab — no cross-join needed (spec did not require execs.totalComp populated). Consistent.

**2. Placeholder scan:** No TBD/TODO. Task 7 Step 1 has a conditional ("if `getSheetPortfolio` is not the export name, read the file and use the real one") — this is a concrete instruction with a hard rule (must return holdings; do not invent), not a placeholder; the route code is complete as written for the expected export.

**3. Type consistency:** Section keys (`board`, `dirComp`, `execBios`, `comp`) are produced by `splitSections` (Task 2) and consumed by parsers: `parseLeadership` reads `execBios` (T3), `parseBoard` reads `board` (T4), `parseComp` reads `comp` (T5) — all match. Payload `{ticker,asOf,source,ceo,execs,board,comp,network}` defined in Task 7, consumed verbatim in Task 8. `network` shape `{nodes,edges:[{person,a,b}]}` consistent T6↔T8. `comp` shape `{rows:[{name,title,total,salaryPct,stockPct,optionPct,otherPct}]}` consistent T5↔T8. `dirComp` section is split but unused by v1 parsers — acceptable (director-pay is not in scope; no task claims it).

No issues found.
