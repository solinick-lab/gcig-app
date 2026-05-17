import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComp, parseBoard, parseLeadership } from './governanceParsers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('-def14a.html')) : [];

test('real fixtures exist (>=1 large-cap)', () => {
  assert.ok(files.length >= 1, 'capture >=1 real DEF 14A fixture (Task 7 Step 1)');
});

for (const f of files) {
  const html = fs.readFileSync(path.join(dir, f), 'utf8');
  test(`${f}: structure-aware extractors return plausible data, never throw`, () => {
    const comp = parseComp(html);
    const board = parseBoard(html);
    const lead = parseLeadership(html);
    const compOk = comp.rows.length > 0 && comp.rows.every((r) => r.total > 0);
    const boardOk = board.length > 0 && board.every((d) => d.age === null || (d.age >= 18 && d.age <= 100));
    assert.ok(
      compOk || boardOk,
      `${f}: expected real Comp rows or Board directors (comp=${comp.rows.length}, board=${board.length})`
    );
    assert.ok(Array.isArray(lead.execs) && Array.isArray(board));
    assert.ok(lead.ceo === null || typeof lead.ceo.name === 'string');

    // Name quality: this is the tier we ship as the working SCT
    // panel, so the name column must read as a real person — not a
    // title fragment, not a footnote-tagged blob. 1–4 capitalized
    // tokens (initials like "R." allowed), and none of the role/
    // footnote contamination we saw leak from AMZN/KO multi-row
    // name cells. The apostrophe class admits the typographic ’
    // (U+2019) as well as the ASCII ' — Apple's source spells
    // "O’Brien" with the curly form; that's a real surname, not
    // contamination, and the digit/paren/role-word checks below are
    // what actually fence out the garbage.
    const NAME_OK = /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/;
    const CONTAM =
      /[0-9()]|\b(Chair|Chairman|Chief|Officer|President|Executive|Vice|Founder|Director|and)\b/i;
    for (const r of comp.rows) {
      assert.match(
        r.name,
        NAME_OK,
        `${f}: comp row name "${r.name}" is not a clean 1–4 token person name`
      );
      assert.doesNotMatch(
        r.name,
        CONTAM,
        `${f}: comp row name "${r.name}" carries title/footnote contamination`
      );
    }
  });
}
