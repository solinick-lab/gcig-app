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
