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

test('parseBoard extracts Irish-surname directors and month-form since', () => {
  const board = parseBoard({
    board:
      "ELECTION OF DIRECTORS Seamus O'Brien, age 58, has been a director " +
      'since June 2019. He serves on the Audit Committee. ' +
      "Mary O'Connor, age 62, director since January 1, 2020.",
  });
  const ob = board.find((d) => d.name === "Seamus O'Brien");
  assert.ok(ob, "O'Brien director should be found");
  assert.equal(ob.age, 58);
  assert.equal(ob.since, 2019);
  assert.ok(ob.committees.includes('Audit'));
  const oc = board.find((d) => d.name === "Mary O'Connor");
  assert.ok(oc, "O'Connor director should be found");
  assert.equal(oc.since, 2020);
});

test('parseBoard excludes lowercase connector fragments from otherBoards', () => {
  const board = parseBoard({
    board:
      'ELECTION OF DIRECTORS Jane Smith, age 55, director since 2017. ' +
      'Jane Smith serves on the board of Globex Corporation and also ' +
      'advises several private startups.',
  });
  const js = board.find((d) => d.name === 'Jane Smith');
  assert.ok(js, 'Jane Smith director should be found');
  // Without the /^[A-Z]/ guard, the post-"and" fragment
  // "also advises several private startups" (lowercase, no "committee"
  // keyword) would wrongly be captured as an other board.
  assert.deepEqual(js.otherBoards, ['Globex Corporation']);
});

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
  assert.equal(jane.salaryPct, 10);
  assert.equal(jane.stockPct, 50);
  assert.equal(jane.optionPct, 30);
});

test('parseComp returns empty rows on missing section', () => {
  assert.deepEqual(parseComp({}), { rows: [] });
});

test('parseComp nulls the mix (keeps total) when SCT cells collapsed (<6 numbers)', () => {
  // Bonus + Option + NonEquity were $0 and vanished from the text:
  // only Salary, Stock, AllOther, Total survive (4 numbers).
  const { rows } = parseComp({
    comp:
      'SUMMARY COMPENSATION TABLE ' +
      'Jane A. Doe Chief Executive Officer 2025 1,000,000 5,000,000 200,000 6,200,000',
  });
  const jane = rows.find((r) => /Jane A\. Doe/.test(r.name));
  assert.ok(jane, 'row should still be emitted');
  assert.equal(jane.total, 6200000);          // total still trustworthy
  assert.equal(jane.salaryPct, null);          // mix not fabricated
  assert.equal(jane.stockPct, null);
  assert.equal(jane.optionPct, null);
  assert.equal(jane.otherPct, null);
});

test('parseComp skips rows with too few numbers or zero total', () => {
  const a = parseComp({
    comp: 'SUMMARY COMPENSATION TABLE Jane A. Doe President 2025 1,000 2,000',
  });
  assert.deepEqual(a.rows, []); // 2 numbers < the {3,7} repetition floor → no match
  const b = parseComp({
    comp:
      'SUMMARY COMPENSATION TABLE ' +
      'Jane A. Doe President 2025 0 0 0 0 0 0',
  });
  assert.deepEqual(b.rows, []); // total (last number) is 0 → skipped
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
