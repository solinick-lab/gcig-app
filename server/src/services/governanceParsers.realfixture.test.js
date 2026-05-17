import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComp, parseBoard, parseLeadership } from './governanceParsers.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('-def14a.html')) : [];

// A name column reads as a person, not a title fragment, when it is
// 1–4 capitalized tokens (initials like "R." allowed) and carries none
// of the role/footnote words a packed Name cell glues on. The same
// NAME_OK shape backs both the SCT panel and the board roster — they
// fail for the same reason (a title or designation riding the name),
// so the check is shared; only the contamination vocabulary differs
// per call site. The apostrophe class admits the typographic ’ (U+2019)
// as well as ASCII ' — Apple spells "O’Brien" with the curly form, a
// real surname, not contamination.
const NAME_OK = /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/;
function assertCleanPersonName(name, contamRe, label) {
  assert.match(name, NAME_OK, `${label}: "${name}" is not a clean 1–4 token person name`);
  assert.doesNotMatch(name, contamRe, `${label}: "${name}" carries title/role contamination`);
}

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
    // title fragment, not a footnote-tagged blob. The role/footnote
    // contamination we saw leak from AMZN/KO multi-row name cells.
    const COMP_CONTAM =
      /[0-9()]|\b(Chair|Chairman|Chief|Officer|President|Executive|Vice|Founder|Director|and)\b/i;
    for (const r of comp.rows) {
      assertCleanPersonName(r.name, COMP_CONTAM, `${f}: comp row name`);
    }

    // Same standard for the director roster. parseBoard's
    // conventional-table fix surfaced AAPL's matrix, but its Name
    // cell glues a trailing role designation onto the chairman
    // ("Art Levinson Board Chair") — the same name-vs-title
    // contamination class the SCT split already solves. For every
    // fixture that yields board rows (MLAB and AAPL today), every
    // director.name must read as a person, with the designation
    // vocabulary a roster cell can trail (Board/Lead/Independent/
    // Member/Nominee/Chairperson on top of the C-suite set).
    const BOARD_CONTAM =
      /[0-9()]|\b(Chair|Chairman|Chairperson|Chief|Officer|President|Vice|Founder|Director|Lead|Independent|Member|Nominee|and)\b/i;
    for (const d of board) {
      assertCleanPersonName(d.name, BOARD_CONTAM, `${f}: board director name`);
    }

    // The conventional small/mid-cap recall floor. MLAB is a
    // textbook director roster — a real <table>, "Nominee's Name"
    // header, seven rows. AAPL/AMZN/KO ship their boards as bio
    // cards (Board legitimately empty there), so without a plain-
    // table fixture nothing would notice parseBoard going dark on
    // the ordinary case. Assert the full roster reads, with the
    // year a numeric `since` (the parser stores Number, not the
    // raw cell string).
    if (/^MLAB-/.test(f)) {
      const names = board.map((d) => d.name.replace(/\s+/g, ' ').trim());
      assert.equal(
        board.length,
        7,
        `MLAB: expected 7 directors from the nominee roster, got ${board.length} (${JSON.stringify(names)})`
      );
      for (const want of ['John Sullivan', 'Gary Owens', 'Mark Capone']) {
        assert.ok(
          names.includes(want),
          `MLAB: roster missing "${want}" (got ${JSON.stringify(names)})`
        );
      }
      const sinceOf = (nm) =>
        board.find((d) => d.name.replace(/\s+/g, ' ').trim() === nm)?.since;
      assert.equal(sinceOf('John Sullivan'), 2009, 'MLAB: John Sullivan since');
      assert.equal(sinceOf('Gary Owens'), 2017, 'MLAB: Gary Owens since');
      assert.equal(sinceOf('Mark Capone'), 2024, 'MLAB: Mark Capone since');
    }
  });
}
