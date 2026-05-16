import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLatestDef14A } from './proxyStatement.js';

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
