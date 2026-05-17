import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickLatestDef14A,
  getProxyStatement,
  _resetProxyCache,
} from './proxyStatement.js';

const FILINGS = [
  { accessionNumber: 'a2', form: 'DEFA14A', filingDate: '2026-04-02', primaryDocument: 'extra.htm', url: 'https://x/extra.htm' },
  { accessionNumber: 'a1', form: 'DEF 14A', filingDate: '2026-03-15', primaryDocument: 'p.htm', url: 'https://www.sec.gov/Archives/edgar/data/1/000/xslF345X09/p2026.htm' },
  { accessionNumber: 'a0', form: 'DEF 14A', filingDate: '2025-03-10', primaryDocument: 'p.htm', url: 'https://x/p2025.htm' },
  { accessionNumber: 'a9', form: '4', filingDate: '2026-05-01', primaryDocument: 'f4.xml', url: 'https://x/f4.xml' },
];

test('pickLatestDef14A: newest DEF 14A, never DEFA14A, xsl stripped', () => {
  const f = pickLatestDef14A(FILINGS);
  assert.equal(f.filingDate, '2026-03-15');
  assert.equal(f.url, 'https://www.sec.gov/Archives/edgar/data/1/000/p2026.htm');
  assert.equal(pickLatestDef14A(FILINGS.filter((x) => x.form !== 'DEF 14A')), null);
  assert.equal(pickLatestDef14A(null), null);
});

test('getProxyStatement returns raw html (no sections) on a found proxy', async () => {
  _resetProxyCache();
  let docCalls = 0;
  const opts = {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-03-15', url: 'https://x/p.htm' }],
    docFetch: async () => { docCalls++; return '<html><body><table><tr><th>Salary</th><th>Total</th></tr></table></body></html>'; },
  };
  const a = await getProxyStatement('AAA', opts);
  const b = await getProxyStatement('AAA', opts);
  assert.equal(a._source, 'sec');
  assert.equal(a.filedAt, '2026-03-15');
  assert.match(a.html, /<table>/);
  assert.equal('sections' in a, false);
  assert.equal(docCalls, 1);
  assert.strictEqual(b, a);
});

test('getProxyStatement stub (never throws) when no DEF 14A / on error', async () => {
  _resetProxyCache();
  const none = await getProxyStatement('NOPE', { filingsFetch: async () => [] });
  assert.equal(none._source, null);
  assert.equal(none.html, '');
  _resetProxyCache();
  const errd = await getProxyStatement('ERR', {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://x/p.htm' }],
    docFetch: async () => { throw new Error('sec down'); },
  });
  assert.equal(errd._source, null);
  assert.equal(errd.html, '');
});

test('getProxyStatement caps html size', async () => {
  _resetProxyCache();
  const big = 'x'.repeat(6 * 1024 * 1024);
  const r = await getProxyStatement('BIG', {
    filingsFetch: async () => [{ form: 'DEF 14A', filingDate: '2026-01-01', url: 'https://x/p.htm' }],
    docFetch: async () => big,
  });
  assert.equal(r._source, 'sec');
  assert.ok(r.html.length <= 4 * 1024 * 1024);
});
