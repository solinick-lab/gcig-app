import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLatestDef14A, htmlToText, splitSections, getProxyStatement, _resetProxyCache } from './proxyStatement.js';

const FILINGS = [
  { accessionNumber: '0000000000-26-000002', form: 'DEFA14A', filingDate: '2026-04-02', primaryDocument: 'extra.htm', url: 'https://x/extra.htm' },
  { accessionNumber: '0000000000-26-000001', form: 'DEF 14A', filingDate: '2026-03-15', primaryDocument: 'proxy2026.htm', url: 'https://www.sec.gov/Archives/edgar/data/320193/000/xslF345X09/proxy2026.htm' },
  { accessionNumber: '0000000000-25-000001', form: 'DEF 14A', filingDate: '2025-03-10', primaryDocument: 'proxy2025.htm', url: 'https://x/proxy2025.htm' },
  { accessionNumber: '0000000000-26-000009', form: '4', filingDate: '2026-05-01', primaryDocument: 'f4.xml', url: 'https://x/f4.xml' },
];

test('pickLatestDef14A picks the newest DEF 14A (never DEFA14A), strips xsl viewer', () => {
  const f = pickLatestDef14A(FILINGS);
  assert.equal(f.filingDate, '2026-03-15');
  assert.equal(f.url, 'https://www.sec.gov/Archives/edgar/data/320193/000/proxy2026.htm'); // realistic xslF345X09 segment stripped
});

test('pickLatestDef14A returns null when no DEF 14A present', () => {
  assert.equal(pickLatestDef14A(FILINGS.filter((x) => x.form !== 'DEF 14A')), null);
  assert.equal(pickLatestDef14A([]), null);
  assert.equal(pickLatestDef14A(null), null);
});

test('xsl strip handles realistic segment and leaves raw URLs unchanged', () => {
  const stripped = pickLatestDef14A([
    { form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://www.sec.gov/Archives/edgar/data/320193/000/xslF345X09/p.htm' },
  ]);
  assert.equal(stripped.url, 'https://www.sec.gov/Archives/edgar/data/320193/000/p.htm');
  const raw = pickLatestDef14A([
    { form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://www.sec.gov/Archives/edgar/data/320193/000/p.htm' },
  ]);
  assert.equal(raw.url, 'https://www.sec.gov/Archives/edgar/data/320193/000/p.htm');
});

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
  const r = await getProxyStatement('NOPE', { filingsFetch: async () => [] });
  assert.equal(r._source, null);
  assert.deepEqual(r.sections, {});
});

test('splitSections skips a leading table-of-contents heading', () => {
  const doc =
    'TABLE OF CONTENTS ELECTION OF DIRECTORS 12 DIRECTOR COMPENSATION 28 ' +
    'EXECUTIVE OFFICERS 35 SUMMARY COMPENSATION TABLE 42 ' +
    'X'.repeat(1000) + ' ' +
    'ELECTION OF DIRECTORS Jane Real, age 60, director since 2010. ' +
    'EXECUTIVE OFFICERS John Real President. ' +
    'SUMMARY COMPENSATION TABLE Salary Bonus Stock Awards.';
  const s = splitSections(doc);
  assert.match(s.board, /Jane Real, age 60/);
  assert.doesNotMatch(s.board, /ELECTION OF DIRECTORS 12 DIRECTOR COMPENSATION/);
  assert.match(s.execBios, /John Real President/);
  assert.match(s.comp, /Salary Bonus Stock Awards/);
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
  assert.equal(b._source, 'sec');
  assert.deepEqual(b, a);
  assert.equal(a._source, 'sec');
  assert.match(a.sections.board, /Jane Doe age 55/);
  assert.equal(docCalls, 1);
});
