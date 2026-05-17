import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadership, parseBoard, parseComp, buildNetwork } from './governanceParsers.js';

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

test('parseLeadership handles Irish surnames and month-form since dates', () => {
  const { ceo, execs } = parseLeadership({
    execBios:
      'EXECUTIVE OFFICERS Patrick O\'Brien, 52, has served as Chief Executive Officer ' +
      'since June 2018. Maria DeLuca, 49, has served as Chief Financial Officer ' +
      'since January 1, 2020.',
  });
  assert.equal(ceo.name, "Patrick O'Brien");
  assert.equal(ceo.since, 2018);
  const cfo = execs.find((e) => e.title === 'Chief Financial Officer');
  assert.equal(cfo.name, 'Maria DeLuca');
  assert.equal(cfo.since, 2020);
});

test('parseLeadership still rejects all-caps heading tokens and Corp. as names', () => {
  const { ceo } = parseLeadership({
    execBios:
      'EXECUTIVE OFFICERS Jane A. Doe, 54, has served as Chief Executive Officer since 2018.',
  });
  assert.equal(ceo.name, 'Jane A. Doe'); // not "OFFICERS Jane A. Doe"
});

test('parseLeadership extracts priorRoles across an Ms./Mr. honorific', () => {
  const { ceo } = parseLeadership({
    execBios:
      'EXECUTIVE OFFICERS Jane A. Doe, 54, has served as Chief Executive Officer ' +
      'since 2018. Previously, Ms. Doe was President of Acme Corp.',
  });
  assert.ok(Array.isArray(ceo.priorRoles) && ceo.priorRoles.length >= 1,
    'expected at least one prior role parsed across "Ms."');
  assert.match(ceo.priorRoles[0], /President/);
});

const BOARD_HTML = `<html><body>
<div>TABLE OF CONTENTS Election of Directors .... 10</div>
<table><tr><td><table>
 <tr><th>Name</th><th>Age</th><th>Director Since</th><th>Committees</th><th>Other Public Company Directorships</th></tr>
 <tr><td>Maria Lopez</td><td>61</td><td>2015</td><td>Audit; Compensation</td><td>Globex Corporation; Initech Inc</td></tr>
 <tr><td>Patrick O'Brien</td><td>58</td><td>2019</td><td>Nominating</td><td>Soylent Corp</td></tr>
</table></td></tr></table></body></html>`;

test('parseBoard reads the director table (age, since, committees, other boards)', () => {
  const b = parseBoard(BOARD_HTML);
  const m = b.find((d) => d.name === 'Maria Lopez');
  assert.ok(m);
  assert.equal(m.age, 61);
  assert.equal(m.since, 2015);
  assert.deepEqual(m.committees.sort(), ['Audit', 'Compensation'].sort());
  assert.deepEqual(m.otherBoards.sort(), ['Globex Corporation', 'Initech Inc'].sort());
  const o = b.find((d) => d.name === "Patrick O'Brien");
  assert.ok(o, "Irish surname row parsed");
  assert.equal(o.since, 2019);
});

test('parseBoard text-record fallback when no director table', () => {
  const b = parseBoard(`<html><body><h2>Election of Directors</h2>
   <p>Maria Lopez, age 61, has been a director since June 2015. She serves on the Audit Committee.</p>
   <p>Patrick O'Brien, age 58, director since 2019.</p></body></html>`);
  const m = b.find((d) => d.name === 'Maria Lopez');
  assert.ok(m, 'fallback parsed Maria');
  assert.equal(m.age, 61);
  assert.equal(m.since, 2015);
  assert.ok(b.some((d) => d.name === "Patrick O'Brien" && d.since === 2019));
});

test('parseBoard empty/garbage → [] (never throws)', () => {
  assert.deepEqual(parseBoard(''), []);
  assert.deepEqual(parseBoard('<p>no table</p>'), []);
  assert.deepEqual(parseBoard(null), []);
});

const COMP_HTML = `<html><body>
<div>TABLE OF CONTENTS Executive Compensation ... 50 Summary Compensation Table ... 64</div>
<table><tr><td><table>
 <tr><td>Name and Principal Position</td><td>Year</td><td>Salary ($)</td><td>Bonus ($)</td><td>Stock Awards ($)</td><td>Option Awards ($)</td><td>Non-Equity ($)</td><td>Total ($)</td></tr>
 <tr><td>Jane A. Doe Chief Executive Officer</td><td>2025</td><td>1,000,000</td><td>0</td><td>5,000,000</td><td>3,000,000</td><td>1,000,000</td><td>10,000,000</td></tr>
 <tr><td>John B. Smith Chief Financial Officer</td><td>2025</td><td>600,000</td><td>0</td><td>1,400,000</td><td>0</td><td>0</td><td>2,000,000</td></tr>
</table></td></tr></table>
</body></html>`;

test('parseComp finds the SCT (nested in a layout table) by header signature and derives pay mix', () => {
  const { rows } = parseComp(COMP_HTML);
  const jane = rows.find((r) => /Jane A\. Doe/.test(r.name));
  assert.ok(jane, 'Jane row parsed');
  assert.equal(jane.total, 10000000);
  assert.equal(jane.salaryPct, 10);
  assert.equal(jane.stockPct, 50);
  assert.equal(jane.optionPct, 30);
  assert.equal(jane.otherPct, 10);
  assert.match(jane.title, /Chief Executive Officer/);
  assert.equal(jane.name, 'Jane A. Doe');
});

test('parseComp ignores a TOC/narrative table lacking a name column', () => {
  const html = `<html><body><table>
   <tr><td>Summary Compensation Table</td><td>Salary discussion and total pay philosophy</td></tr>
  </table></body></html>`;
  assert.deepEqual(parseComp(html), { rows: [] });
});

test('parseComp empty/garbage → { rows: [] } (never throws)', () => {
  assert.deepEqual(parseComp(''), { rows: [] });
  assert.deepEqual(parseComp('<p>no table here</p>'), { rows: [] });
  assert.deepEqual(parseComp(null), { rows: [] });
});

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
  const pairs = n.edges.map((e) => `${e.person}|${e.a}|${e.b}`).sort();
  assert.deepEqual(pairs, ['Maria Lopez|FOCUS|GLBX', 'Maria Lopez|FOCUS|INIT'].sort());
  assert.ok(n.nodes.includes('FOCUS') && n.nodes.includes('GLBX'));
});

test('buildNetwork empty when no overlap / bad input', () => {
  assert.deepEqual(buildNetwork('X', [], []), { nodes: [], edges: [] });
  assert.deepEqual(buildNetwork('X', null, null), { nodes: [], edges: [] });
});

test('buildNetwork excludes the focus company itself (case-insensitive ticker)', () => {
  const board = [{ name: 'A', otherBoards: ['Focus Corp'] }];
  const holdings = [{ ticker: 'focus', name: 'Focus Corp' }];
  const n = buildNetwork('FOCUS', board, holdings);
  assert.deepEqual(n.edges, []);
  assert.deepEqual(n.nodes, []);
});

test('parseBoard: table WITHOUT an Age column (age in prose) still populates via table path', () => {
  const b = parseBoard(`<html><body><table>
   <tr><th>Name</th><th>Independent</th><th>Committees</th><th>Director Since</th><th>Other Public Company Directorships</th></tr>
   <tr><td>Maria Lopez</td><td>Yes</td><td>Audit; Compensation</td><td>2015</td><td>Globex Corporation; Procter and Gamble Company</td></tr>
  </table></body></html>`);
  const m = b.find((d) => d.name === 'Maria Lopez');
  assert.ok(m, 'director populated with no Age column');
  assert.equal(m.since, 2015);
  assert.equal(m.age, null); // honest: no age column
  assert.deepEqual(m.committees.sort(), ['Audit', 'Compensation'].sort());
  // "Procter and Gamble Company" must NOT be split at "and":
  assert.deepEqual(m.otherBoards.sort(), ['Globex Corporation', 'Procter and Gamble Company'].sort());
});

test('parseBoard fallback matches the dominant "Name, NN," bio form (no "age" word) + footnote age in table', () => {
  const f = parseBoard(`<html><body><h2>Election of Directors</h2>
   <p>Maria Lopez, 61, has been a director since 2015. Ms. Lopez serves on the Audit Committee.</p>
   <p>Patrick O'Brien (age 58) has served as a director since June 2019.</p></body></html>`);
  const m = f.find((d) => d.name === 'Maria Lopez');
  assert.ok(m, 'matched "Name, NN," bio'); assert.equal(m.age, 61); assert.equal(m.since, 2015);
  const o = f.find((d) => d.name === "Patrick O'Brien");
  assert.ok(o, 'matched "Name (age NN)"'); assert.equal(o.age, 58); assert.equal(o.since, 2019);

  const t = parseBoard(`<html><body><table>
   <tr><th>Name</th><th>Age</th><th>Director Since</th></tr>
   <tr><td>Jane Doe</td><td>61(1)</td><td>2015</td></tr></table></body></html>`);
  assert.equal(t.find((d) => d.name === 'Jane Doe').age, 61); // footnote (1) not 611
});

const COMP_REAL = `<html><body><table>
 <tr><td>Name and Principal Position</td><td>Year</td><td>Salary ($)</td><td>Bonus ($)</td><td>Stock Awards ($)</td><td>Option Awards ($)</td><td>Total ($)</td></tr>
 <tr><td>Andrew R. Jassy President and Chief Executive Officer</td><td>2025</td><td>1,000,000</td><td>0</td><td>5,000,000</td><td>3,000,000</td><td>10,000,000(3)</td></tr>
 <tr><td>Brian T. Olsavsky Senior Vice President and Chief Financial Officer</td><td>2025</td><td>800,000</td><td>0</td><td>1,200,000</td><td>0</td><td>2,000,000</td></tr>
</table></body></html>`;

test('parseComp: real name/title split (VP before C-title) and footnote-safe totals', () => {
  const { rows } = parseComp(COMP_REAL);
  const jassy = rows.find((r) => /Jassy/.test(r.name));
  assert.equal(jassy.name, 'Andrew R. Jassy');
  assert.match(jassy.title, /Chief Executive Officer/);
  assert.equal(jassy.total, 10000000); // NOT 100000003 (footnote (3) stripped)
  assert.equal(jassy.stockPct, 50);
  const cfo = rows.find((r) => /Olsavsky/.test(r.name));
  assert.equal(cfo.name, 'Brian T. Olsavsky'); // NOT truncated at "Vice"
  assert.match(cfo.title, /Chief Financial Officer/); // NOT "President"
  assert.equal(cfo.total, 2000000);
});
