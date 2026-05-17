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
