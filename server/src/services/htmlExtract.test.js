import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHtml,
  cellText,
  tableRows,
  findTableBySignature,
  headerMap,
  locateSectionText,
} from './htmlExtract.js';

const HTML = `
<html><body>
<div>TABLE OF CONTENTS Summary Compensation Table .... 64</div>
<h2>Summary Compensation Table</h2>
<table>
  <tr><th>Name and Principal Position</th><th>Year</th><th>Salary&nbsp;($)</th><th>Bonus ($)</th><th>Stock Awards ($)</th><th>Option Awards ($)</th><th>Total ($)</th></tr>
  <tr><td>Jane A. Doe, CEO</td><td>2025</td><td>1,000,000</td><td>0</td><td>5,000,000</td><td>3,000,000</td><td>10,000,000</td></tr>
</table>
<h2>Information about our Executive Officers</h2>
<p>Jane A. Doe, 54, has served as Chief Executive Officer since 2018.</p>
<h2>Next Section</h2>
</body></html>`;

test('cellText decodes entities, strips tags, collapses space', () => {
  const root = parseHtml('<td>Salary&nbsp;($)<b> x</b></td>');
  assert.equal(cellText(root.querySelector('td')), 'Salary ($) x');
});

test('findTableBySignature finds the SCT by header cells', () => {
  const root = parseHtml(HTML);
  const t = findTableBySignature(root, (cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /salary/.test(j) && /total/.test(j);
  });
  assert.ok(t, 'SCT table found');
  const rows = tableRows(t);
  assert.equal(rows.length, 2);
  const hm = headerMap(rows[0]);
  assert.equal(hm.total >= 0, true);
  assert.equal(rows[1][hm.total], '10,000,000');
  assert.equal(rows[1][hm.salary], '1,000,000');
});

test('locateSectionText returns text after a heading up to the next heading', () => {
  const root = parseHtml(HTML);
  const txt = locateSectionText(root, /executive officers/i);
  assert.match(txt, /Jane A\. Doe, 54, has served as Chief Executive Officer since 2018/);
  assert.doesNotMatch(txt, /Next Section/);
});

test('helpers never throw on garbage', () => {
  assert.doesNotThrow(() => findTableBySignature(parseHtml(''), () => true));
  assert.equal(findTableBySignature(parseHtml('<p>x</p>'), () => true), null);
  assert.equal(locateSectionText(parseHtml('<p>x</p>'), /nope/), '');
});

// Real SEC proxies wrap the data table in layout table(s). The header/
// data rows must NOT be contaminated by the outer wrapper, and the
// SCT we return must be the INNER data table.
const NESTED = `<html><body>
<table id="layout"><tr><td>
  <table id="sct">
    <tr><th>Name and Principal Position</th><th>Salary ($)</th><th>Total ($)</th></tr>
    <tr><td>Jane A. Doe</td><td>1,000,000</td><td>10,000,000</td></tr>
  </table>
</td></tr></table>
</body></html>`;

test('findTableBySignature returns the inner data table, not the layout wrapper', () => {
  const root = parseHtml(NESTED);
  const t = findTableBySignature(root, (cells) => {
    const j = cells.join(' | ').toLowerCase();
    return /salary/.test(j) && /total/.test(j) && /name|principal position/.test(j);
  });
  assert.ok(t, 'a table matched');
  const rows = tableRows(t);
  // Inner SCT has exactly a header row + one data row, clean cells.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['Name and Principal Position', 'Salary ($)', 'Total ($)']);
  const hm = headerMap(rows[0]);
  assert.equal(rows[1][hm.name], 'Jane A. Doe');
  assert.equal(rows[1][hm.salary], '1,000,000');
  assert.equal(rows[1][hm.total], '10,000,000');
  assert.notEqual(hm.name, hm.salary); // distinct columns, not collapsed
});

test('locateSectionText does not duplicate text across nested ancestors', () => {
  const root = parseHtml(`<html><body>
    <h2>Information about our Executive Officers</h2>
    <div><div><p>Jane A. Doe, 54, has served as Chief Executive Officer since 2018.</p></div></div>
    <div><p>John B. Smith, 47, has served as Chief Financial Officer since 2021.</p></div>
    <h2>Corporate Governance</h2><div><p>unrelated text</p></div>
  </body></html>`);
  const txt = locateSectionText(root, /executive officers/i);
  // Each sentence appears exactly once (no ancestor duplication).
  const occ = (txt.match(/Jane A\. Doe, 54/g) || []).length;
  assert.equal(occ, 1);
  assert.match(txt, /John B\. Smith, 47/);
  assert.doesNotMatch(txt, /unrelated text/);
});

test('headerMap does not collapse name and since on a "Director Since" header', () => {
  const hm = headerMap(['Name', 'Age', 'Director Since', 'Committees']);
  assert.equal(hm.name, 0);
  assert.equal(hm.age, 1);
  assert.equal(hm.since, 2);
  assert.notEqual(hm.name, hm.since);
});

test('headerMap recovers the "Name and Principal Executive Officers" variant without re-colliding', () => {
  const a = headerMap(['Name and Principal Executive Officers', 'Year', 'Salary ($)', 'Total ($)']);
  assert.equal(a.name, 0);
  assert.equal(a.salary, 2);
  assert.equal(a.total, 3);
  // Director Since collision must STILL be fixed:
  const b = headerMap(['Name', 'Age', 'Director Since', 'Committees']);
  assert.equal(b.name, 0);
  assert.equal(b.since, 2);
  assert.notEqual(b.name, b.since);
});

test('tableRows expands colspan so header/data columns stay aligned', () => {
  const root = parseHtml(`<table>
    <tr><th>Name</th><th colspan="2">Stock Awards</th><th>Total</th></tr>
    <tr><td>Jane</td><td>4,000,000</td><td>1,000,000</td><td>10,000,000</td></tr>
  </table>`);
  const rows = tableRows(root.querySelector('table'));
  // header colspan=2 → 2 slots, so both rows have 4 cells, aligned.
  assert.equal(rows[0].length, 4);
  assert.equal(rows[1].length, 4);
  const hm = headerMap(rows[0]);
  assert.equal(rows[1][hm.total], '10,000,000'); // total index aligned
  assert.equal(rows[1][hm.name], 'Jane');
});

test('headerMap: since covers Tenure / Year First Elected; otherboards covers Public Company Boards', () => {
  const a = headerMap(['Name', 'Tenure', 'Public Company Boards']);
  assert.equal(a.name, 0);
  assert.equal(a.since, 1);
  assert.equal(a.otherboards, 2);
  const b = headerMap(['Director', 'Age', 'Year First Elected', 'Other Public Company Directorships']);
  assert.equal(b.since, 2);
  assert.equal(b.otherboards, 3);
});
