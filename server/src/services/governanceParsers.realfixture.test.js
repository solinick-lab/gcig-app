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
// real surname, not contamination. The letter class is the Unicode
// letter property, not ASCII a–z: Coca-Cola's board carries "Ana
// Botín" and the same diacritics show up across large-cap rosters.
// Widening the class doesn't loosen the gate — the structural shape
// (one capital, 1–4 tokens, dot/apostrophe/hyphen only) and the
// separate role-word contamination check are unchanged; "Art
// Levinson Board Chair" and "Chief Executive" still fail both.
const NAME_OK = /^\p{Lu}[\p{L}.'’-]+(?:\s+\p{Lu}[\p{L}.'’-]+){1,3}$/u;
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

      // A conventional roster's only per-director prose is the
      // "Position(s) with the Company" cell; bio is exactly that
      // text. Gary Owens's row carries the full officer line, so it
      // is the stable, unambiguous ground truth.
      const bioOf = (nm) =>
        board.find((d) => d.name.replace(/\s+/g, ' ').trim() === nm)?.bio;
      assert.equal(
        typeof bioOf('Gary Owens'),
        'string',
        `MLAB: Gary Owens bio should be a string (got ${JSON.stringify(bioOf('Gary Owens'))})`
      );
      assert.equal(
        bioOf('Gary Owens'),
        'Director, President, and Chief Executive Officer',
        `MLAB: Gary Owens bio should equal the position cell (got ${JSON.stringify(bioOf('Gary Owens'))})`
      );
      assert.ok(
        typeof bioOf('John Sullivan') === 'string' &&
          bioOf('John Sullivan').includes('Chairperson of the Board'),
        `MLAB: John Sullivan bio should carry the position text (got ${JSON.stringify(bioOf('John Sullivan'))})`
      );
    }

    // AMZN and KO ship no conventional roster — each director is a
    // bespoke styled bio-card table — so the card path must recover
    // the full board, by name + tenure year + age, without scooping
    // the proxy-summary bullet lists, skills/committee matrices, or
    // (KO) the all-caps photo montage that would mint a phantom
    // non-nominee. The gate pins the traps explicitly: the AMZN
    // non-nominee Keith B. Alexander must be absent; for KO the
    // CHAIRMAN-SINCE / LEAD-INDEPENDENT-SINCE labels co-occur with
    // DIRECTOR SINCE in the Quincey and Weinberg cards, so Weinberg
    // must read 2015 (his board tenure), not 2024 (his lead-director
    // tenure), and the montage-only Maria Elena Lagomasino must not
    // appear. Names normalize the same way across filers, so KO's
    // all-caps cards are asserted title-cased.
    const findBy = (nm) =>
      board.find((d) => d.name.replace(/\s+/g, ' ').trim() === nm);
    if (/^AMZN-/.test(f)) {
      const names = board.map((d) => d.name.replace(/\s+/g, ' ').trim());
      assert.ok(
        board.length >= 11,
        `AMZN: expected >=11 bio-card directors, got ${board.length} (${JSON.stringify(names)})`
      );
      const want = {
        'Jeffrey P. Bezos': [1994, 62],
        'Andrew R. Jassy': [2021, 58],
        'Indra K. Nooyi': [2019, 70],
        'Wendell P. Weeks': [2016, 66],
      };
      for (const [nm, [since, age]] of Object.entries(want)) {
        const d = findBy(nm);
        assert.ok(d, `AMZN: card roster missing "${nm}" (got ${JSON.stringify(names)})`);
        assert.equal(d.since, since, `AMZN: ${nm} since`);
        assert.equal(d.age, age, `AMZN: ${nm} age`);
      }
      assert.ok(
        !names.includes('Keith B. Alexander'),
        `AMZN: non-nominee Keith B. Alexander leaked into the roster (${JSON.stringify(names)})`
      );

      // AMZN bio = the card's role line plus its qualifications /
      // background prose, drawn from the same card already parsed.
      // The ground-truth phrases are sentences from the SEC-filed
      // "Background" / "Expertise" disclosure, not layout text, so
      // they survive a card restyle.
      const jassy = findBy('Andrew R. Jassy');
      assert.equal(
        typeof jassy.bio,
        'string',
        `AMZN: Jassy bio should be a string (got ${JSON.stringify(jassy.bio)})`
      );
      assert.ok(
        jassy.bio.length > 40,
        `AMZN: Jassy bio should be substantive (len=${jassy.bio.length})`
      );
      assert.ok(
        jassy.bio.includes(
          'the first Chief Executive Officer and leader of Amazon Web Services'
        ),
        `AMZN: Jassy bio missing the AWS-history phrase (got ${JSON.stringify(jassy.bio)})`
      );
      assert.ok(
        jassy.bio.includes(
          'He founded and led Amazon Web Services since its inception in 2006'
        ),
        `AMZN: Jassy bio missing the AWS-founding phrase (got ${JSON.stringify(jassy.bio)})`
      );
      const nooyi = findBy('Indra K. Nooyi');
      assert.ok(
        typeof nooyi.bio === 'string' && nooyi.bio.length > 40,
        `AMZN: Nooyi bio should be a substantive string (got ${JSON.stringify(nooyi.bio)})`
      );
      assert.ok(
        nooyi.bio.includes('architect of Performance with Purpose'),
        `AMZN: Nooyi bio missing the PepsiCo-strategy phrase (got ${JSON.stringify(nooyi.bio)})`
      );
    }
    if (/^KO-/.test(f)) {
      const names = board.map((d) => d.name.replace(/\s+/g, ' ').trim());
      assert.ok(
        board.length >= 11,
        `KO: expected >=11 bio-card directors, got ${board.length} (${JSON.stringify(names)})`
      );
      const want = {
        'James Quincey': [2017, 61],
        'Herb Allen': [2021, 58],
        'David B. Weinberg': [2015, 74],
        'Christopher C. Davis': [2018, 60],
      };
      for (const [nm, [since, age]] of Object.entries(want)) {
        const d = findBy(nm);
        assert.ok(d, `KO: card roster missing "${nm}" (got ${JSON.stringify(names)})`);
        assert.equal(d.since, since, `KO: ${nm} since`);
        assert.equal(d.age, age, `KO: ${nm} age`);
      }
      assert.ok(
        !names.includes('Maria Elena Lagomasino'),
        `KO: montage-only Maria Elena Lagomasino leaked into the roster (${JSON.stringify(names)})`
      );

      // KO bio = the Career Highlights + Key Qualifications prose the
      // same card already carries. Quincey's is anchored on the
      // verbatim qualifications sentence; the phrases are filed
      // disclosure, stable across a layout refresh.
      const quincey = findBy('James Quincey');
      assert.equal(
        typeof quincey.bio,
        'string',
        `KO: Quincey bio should be a string (got ${JSON.stringify(quincey.bio)})`
      );
      assert.ok(
        quincey.bio.length > 40,
        `KO: Quincey bio should be substantive (len=${quincey.bio.length})`
      );
      assert.ok(
        quincey.bio.includes(
          'Chief Executive Officer of the Company since May 2017 and Chairman of the Board since April 2019'
        ),
        `KO: Quincey bio missing the role-history phrase (got ${JSON.stringify(quincey.bio)})`
      );
      assert.ok(
        quincey.bio.includes('Over 25 years of Coca-Cola system experience'),
        `KO: Quincey bio missing the tenure phrase (got ${JSON.stringify(quincey.bio)})`
      );
      const allen = findBy('Herb Allen');
      assert.ok(
        typeof allen.bio === 'string' && allen.bio.length > 40,
        `KO: Allen bio should be a substantive string (got ${JSON.stringify(allen.bio)})`
      );
      assert.ok(
        allen.bio.includes(
          'President of Allen & Company LLC, a privately held investment banking firm'
        ),
        `KO: Allen bio missing the qualifications phrase (got ${JSON.stringify(allen.bio)})`
      );

      // The bio capture used to weld the card's all-caps section
      // bars ("CAREER HIGHLIGHTS", "PUBLIC BOARD MEMBERSHIPS", "KEY
      // QUALIFICATIONS AND EXPERIENCES") straight onto the prose, so
      // every KO director opened with run-together gibberish — Herb
      // Allen read "CAREER HIGHLIGHTSPUBLIC BOARD MEMBERSHIPSAllen &
      // Company LLC…". The bars are layout chrome, never content:
      // for every KO director that has a bio it must read as prose,
      // not start with a bar label, and never contain the welded
      // "CAREER HIGHLIGHTSPUBLIC BOARD MEMBERSHIPS" run. Asserted for
      // the whole roster, not one director, so the cleanup can't be
      // a per-card patch.
      for (const d of board) {
        if (d.bio == null) continue;
        assert.equal(
          typeof d.bio,
          'string',
          `KO: ${d.name} bio should be a string or null (got ${JSON.stringify(d.bio)})`
        );
        assert.ok(
          !d.bio.includes('CAREER HIGHLIGHTSPUBLIC BOARD MEMBERSHIPS'),
          `KO: ${d.name} bio still welds the section bars (got ${JSON.stringify(d.bio.slice(0, 160))})`
        );
        assert.doesNotMatch(
          d.bio,
          /^\s*(CAREER HIGHLIGHTS|PUBLIC BOARD MEMBERSHIPS|KEY QUALIFICATIONS)/,
          `KO: ${d.name} bio still opens with an all-caps section bar (got ${JSON.stringify(d.bio.slice(0, 160))})`
        );
      }
      // The cleanup must drop bars, not content: re-assert the
      // verbatim phrases the fix is forbidden to lose. Redundant with
      // the per-director checks above by design — a fix that strips
      // text to satisfy the bar assertions would fail here.
      assert.ok(
        quincey.bio.includes(
          'Chief Executive Officer of the Company since May 2017 and Chairman of the Board since April 2019'
        ),
        `KO: Quincey bio lost the role-history phrase after cleanup (got ${JSON.stringify(quincey.bio)})`
      );
      assert.ok(
        quincey.bio.includes('Over 25 years of Coca-Cola system experience'),
        `KO: Quincey bio lost the tenure phrase after cleanup (got ${JSON.stringify(quincey.bio)})`
      );
      assert.ok(
        allen.bio.includes(
          'President of Allen & Company LLC, a privately held investment banking firm'
        ),
        `KO: Allen bio lost the qualifications phrase after cleanup (got ${JSON.stringify(allen.bio)})`
      );
    }

    // AAPL is the matrix-style conventional roster: the only bio
    // text the document carries in that table is the "Occupation"
    // column. Tim Cook's "CEO, Apple" is the canonical short form;
    // Levinson exercises the chairman row whose Name cell trails a
    // designation, proving the occupation read is independent of the
    // name split.
    if (/^AAPL-/.test(f)) {
      const cook = findBy('Tim Cook');
      assert.ok(cook, `AAPL: roster missing Tim Cook (${JSON.stringify(board.map((d) => d.name))})`);
      assert.equal(
        typeof cook.bio,
        'string',
        `AAPL: Cook bio should be a string (got ${JSON.stringify(cook.bio)})`
      );
      assert.equal(
        cook.bio,
        'CEO, Apple',
        `AAPL: Cook bio should equal the occupation cell (got ${JSON.stringify(cook.bio)})`
      );
      const levinson = findBy('Art Levinson');
      assert.ok(
        typeof levinson.bio === 'string' &&
          levinson.bio.includes('Founder and CEO, Calico'),
        `AAPL: Levinson bio should carry the occupation text (got ${JSON.stringify(levinson.bio)})`
      );
    }

    // Neither AMZN nor KO carries an executive-officer bio section in
    // the proxy (it lives in the 10-K), so leadership falls back to
    // the summary compensation roster. The CEO row reads off the
    // title; age/since are legitimately absent for execs there.
    if (/^AMZN-/.test(f)) {
      assert.equal(lead.ceo && lead.ceo.name, 'Andrew R. Jassy', 'AMZN: SCT-fallback CEO');
      assert.match(lead.ceo.title, /chief executive officer/i, 'AMZN: CEO title');
      const olsavsky = lead.execs.find((e) => e.name === 'Brian T. Olsavsky');
      assert.ok(olsavsky, `AMZN: execs missing Brian T. Olsavsky (${JSON.stringify(lead.execs.map((e) => e.name))})`);
      assert.match(olsavsky.title, /chief financial officer/i, 'AMZN: Olsavsky title');
    }
    if (/^KO-/.test(f)) {
      assert.equal(lead.ceo && lead.ceo.name, 'James Quincey', 'KO: SCT-fallback CEO');
      const execNames = lead.execs.map((e) => e.name);
      for (const want of ['John Murphy', 'Henrique Braun']) {
        assert.ok(
          execNames.includes(want),
          `KO: execs missing "${want}" (${JSON.stringify(execNames)})`
        );
      }
    }
  });
}
