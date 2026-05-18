// MGMT parsers. Each takes the raw DEF 14A html string and walks it
// structurally with node-html-parser — tables found by header
// signature, not by flattening to text and regexing (the old
// approach the table-of-contents kept defeating). Per-field-nullable,
// pure, never throws; recall over precision, "—" for anything not
// confidently extractable.
import { parseHtml, cellText, tableRows, findTableBySignature, findTablesBySignature, headerMap, locateSectionText } from './htmlExtract.js';

// One name-token rule for the leadership parser. The first alternative
// covers ordinary mixed-case words ("Doe", "DeLuca"); the second covers
// Irish O'Xxxx forms ("O'Brien") whose second character is an apostrophe.
// All-caps headings ("OFFICERS") and period-terminated abbreviations
// ("Corp.") satisfy neither branch — intentional.
const NAME_TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
const EXEC_RE = new RegExp(
  `(${NAME_TOKEN}(?:\\s+(?:[A-Z]\\.|${NAME_TOKEN})){1,3}),\\s*(\\d{2}),[^.]*?\\b(Chief [A-Za-z ]+Officer|President|General Counsel|Executive Chairman)\\b(?:[^.]*?since\\s+(?:[A-Za-z]+\\s+){0,2}(?:\\d{1,2},?\\s*)?((?:19|20)\\d{2})|[^.]*)`,
  'g'
);

function priorRoles(text, name) {
  const i = text.indexOf(name);
  if (i < 0) return [];
  const after = text.slice(i, i + 600);
  const out = [];
  const re = /\b(?:prior(?:\sto)?|previously|formerly)\b(?:(?:Ms|Mr|Dr|Jr|Sr)\.|[^.])*?\b(President|Chief [A-Za-z ]+Officer|Partner|Director)\b[^.]*?\bof\s+([A-Z][A-Za-z.,& ]{2,40}?)[.,]/gi;
  let r;
  while ((r = re.exec(after)) !== null && out.length < 3) out.push(`${r[1].trim()}, ${r[2].trim()}`);
  return out;
}

// Best-effort tier: DOM-locate the exec-officers block, then prose-parse.
// Exec bios are narrative even in well-structured proxies — inherently
// lower recall than the table tiers; stated honestly in the spec/UI.
export function parseLeadership(html) {
  const root = parseHtml(html);
  const text =
    locateSectionText(
      root,
      /information about (?:our )?executive officers|(?:our )?executive officers of the (?:company|registrant)|^(?:our )?executive officers$/i
    ) || '';
  const execs = [];
  EXEC_RE.lastIndex = 0;
  let m;
  while ((m = EXEC_RE.exec(text)) !== null) {
    const title = m[3].replace(/\s+/g, ' ').trim();
    execs.push({
      name: m[1].replace(/\s+/g, ' ').trim(),
      title,
      age: m[2] ? Number(m[2]) : null,
      since: m[4] ? Number(m[4]) : null,
      priorRoles: priorRoles(text, m[1]),
      totalComp: null,
    });
  }
  if (execs.length) {
    const ceo = execs.find((e) => /chief executive officer/i.test(e.title)) || execs[0];
    return { ceo: ceo || null, execs };
  }

  // Large-cap proxies (AMZN, KO) carry no executive-officer bio
  // section at all — by SEC rule it lives in the 10-K, and the
  // heading regex above finds nothing in either. Rather than report
  // an empty leadership tab, fall back to the one place the proxy
  // does name the officers: the Summary Compensation Table the comp
  // tier already parses. Age and tenure are genuinely not disclosed
  // for execs there; null is the honest value, not a parse miss. The
  // prose path stays first and untouched, so any filer that *does*
  // publish a real exec section is unaffected.
  const compRows = parseComp(html).rows;
  const sctExecs = compRows.map((r) => ({
    name: r.name,
    title: r.title,
    age: null,
    since: null,
    priorRoles: [],
    totalComp: r.total ?? null,
  }));
  const sctCeo =
    sctExecs.find((e) => /chief executive officer/i.test(e.title)) ||
    sctExecs[0] ||
    null;
  return { ceo: sctCeo, execs: sctExecs };
}

const COMMITTEE_NAMES = ['Audit', 'Compensation', 'Nominating', 'Governance', 'Risk', 'Finance'];

// name + a since/tenure column is enough — many large-cap director
// tables have no Age column (age is in bio prose). Age stays optional.
const BOARD_SIG = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  const hasSince = /(director since|\bsince\b|tenure|year.*elected|first elected)/.test(j);
  const hasName = /name|director|nominee/.test(j);
  return hasName && hasSince;
};

// Director roster. Prefer the nominee/director table (header has Age +
// a since column), found by signature anywhere in the DOM (TOC-proof,
// colspan/nesting handled by htmlExtract). otherBoards prefers a
// dedicated column; committees from its column or row text. If no such
// table exists, fall back to per-director record blocks in the located
// "Election of Directors" section text.
// A matched header row that's actually a header: at least a couple of
// real label cells, every cell short, no checkmark glyph, no
// sentence-length blob. This is what separates the real nominee
// roster from the three other things the loose BOARD_SIG snags — the
// notice-prose table (one ~3,000-char cell), the post-roster
// "Corporate Governance Highlights" checkmark grid, and the
// zero-width-space (U+200B) layout scaffolding some large-caps use to
// position bio cards. A blank/glyph "header" is never a roster, so we
// require this rather than merely prefer it: a no-header table parses
// to phantom directors (zero-width names, titles read as people),
// and returning [] is the honest best-effort answer there.
function looksLikeHeaderRow(cells) {
  if (!cells || !cells.length) return false;
  const real = cells.filter(
    (c) => String(c || '').replace(/[​\s]/g, '').length > 0
  );
  if (real.length < 2) return false;
  return cells.every((c) => {
    const t = String(c || '');
    return t.length <= 60 && !/[✓✔�]/.test(t);
  });
}

// The bio-card tier. Some large-caps (AMZN, KO) don't publish a
// director roster table or inline bio prose at all — every director
// is a self-contained styled "card" laid out as its own one-off
// <table>: a headshot, a name in the house display face, an
// age/tenure strip, committee and board lines. There is no header
// row to signature-match and no narrative to regex; the only stable
// hook is the card's own typography. This tier runs ONLY when the
// conventional table and prose tiers came up empty, so the working
// filers (MLAB's roster, AAPL's matrix) never reach it.
//
// Whitespace-collapsed text, with the zero-width space (U+200B) the
// card layouts pack between cells stripped — it otherwise wedges
// itself into the middle of "Royal␣Philips" and breaks every label
// boundary. cellText already collapses runs; we only add the U+200B.
const ZW = /[​﻿]/g;
const flat = (s) => String(s == null ? '' : s).replace(ZW, '').replace(/\s+/g, ' ').trim();

// A director's biography rides on the very card/row parseBoard
// already matched — no second fetch, no schema beyond this field.
// It is best-effort prose: a long single string when the filer
// publishes narrative qualifications (the AMZN/KO bio cards), the
// terse occupation line when the filer only tabulates one (AAPL's
// "Occupation", MLAB's "Position(s) with the Company"), and `null`
// when the card/row carries nothing worth surfacing. A defensive
// cap keeps a pathological card from ballooning the payload; real
// disclosures sit well under it (KO's densest qualifications card
// is ~2,800 chars, comfortably inside).
const BIO_CAP = 4000;
const tidyBio = (s) => {
  const t = flat(s);
  if (!t || t.length < 2) return null;
  return t.length > BIO_CAP ? t.slice(0, BIO_CAP).trim() : t;
};

// The card families bury the same thing — the person's filed
// qualifications/background prose — behind different scaffolding,
// so each gets its own slice of the already-collapsed card text
// (cellText has done the tag-strip and whitespace work; we only
// trim the parts that aren't bio).
//
// AMZN prints the name first, then the role line, then the skills/
// expertise/background narrative, and closes with the labelled
// strip ("Age:", "Director since:", "Board committees:", "Other
// current public company boards:"). Drop the leading name and
// everything from that labelled tail onward; what remains is the
// title plus the substantive prose. Anchoring the tail on "Age:"
// is safe — it is the first label and never appears in the prose
// above it.
function amznCardBio(t, name) {
  let body = flat(cellText(t));
  if (name && body.startsWith(name)) body = body.slice(name.length).trim();
  const cut = body.search(/\bAge:\s*\d{2}\b/i);
  if (cut > 0) body = body.slice(0, cut).trim();
  return tidyBio(body);
}

// KO front-loads the name and the labelled fields ("AGE: … |",
// "DIRECTOR SINCE:", "COMMITTEES:") and only then the prose, which
// opens at the "CAREER HIGHLIGHTS" section bar and runs through the
// board memberships and "KEY QUALIFICATIONS AND EXPERIENCES" to the
// end of the card. Take from that bar onward; if a card somehow
// lacks it, fall back to the qualifications bar so a reshuffled
// card still yields something.
function koCardBio(t) {
  const body = flat(cellText(t));
  const m = body.match(
    /(CAREER HIGHLIGHTS|KEY QUALIFICATIONS AND EXPERIENCES)[\s\S]*$/i
  );
  return tidyBio(m ? m[0] : '');
}

// A text node's OWN text (not its descendants'), so a label like
// "Director since:" can be located by the element that literally
// contains it rather than any ancestor that also contains the value.
function ownText(el) {
  if (!el || !el.childNodes) return '';
  return flat(
    el.childNodes
      .filter((c) => c.nodeType === 3)
      .map((c) => String(c.text || ''))
      .join('')
  );
}

// The two card families differ only in which typed node carries the
// name and how the fields are labelled; detection is one shape. AMZN
// prints the name in a bold amber 10pt <div>; KO in a 24pt bold <b>.
// A card always shows a "since" label too — that label, present in
// the SAME table as the styled name, is what separates a real card
// from every look-alike the document also contains (proxy-summary
// nominee bullets, the skills/committee matrices, the photo montage,
// the ownership and compensation tables): those carry names but no
// per-director age/tenure label, or a label with no styled name.
function amznNameNodes(t) {
  return t.querySelectorAll('div').filter((d) => {
    const s = String(d.getAttribute('style') || '').toLowerCase();
    return (
      s.includes('font-weight:bold') &&
      s.includes('color:#ff9e15') &&
      s.includes('font-size:10pt')
    );
  });
}
function koNameNodes(t) {
  return t.querySelectorAll('b').filter((b) => {
    const s = String(b.getAttribute('style') || '').toLowerCase();
    return s.includes('font-size:24pt') && s.includes('font-weight:bold');
  });
}
// KO runs the label and the year as separate <b> nodes inside one
// <p> ("DIRECTOR SINCE:" then the value), and the very same card
// carries "CHAIRMAN SINCE:" / "LEAD INDEPENDENT DIRECTOR SINCE:" for
// the chair and lead director. A regex over the card's collapsed
// text picks the wrong year there (Weinberg's lead-director 2024
// instead of his board 2015, because "INDEPENDENT DIRECTOR" feeds a
// false word boundary). Anchor on the <b> whose own text is exactly
// the bare "DIRECTOR SINCE:" label and read the year off that node's
// own <p>, so the sibling SINCE lines can't bleed in.
function koHasDirectorSinceLabel(t) {
  return t
    .querySelectorAll('b')
    .some((b) => /^DIRECTOR SINCE:\s*$/i.test(ownText(b)));
}

// Uppercase → Title Case, KO only (its cards print names all-caps;
// every other filer is already mixed-case and must not be touched).
// A single-letter initial keeps its dot ("C." stays "C."); diacritic
// letters are preserved because toLowerCase/charAt handle them
// natively ("ANA BOTÍN" → "Ana Botín", "CHRISTOPHER C. DAVIS" →
// "Christopher C. Davis").
function titleCaseName(s) {
  return flat(s)
    .toLowerCase()
    .split(' ')
    .map((w) => {
      if (!w) return w;
      if (/^[a-z]\.$/.test(w)) return w[0].toUpperCase() + '.';
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

const isNoneVal = (s) => !s || /^none$/i.test(flat(s));

// AMZN labels each field in its own node whose parent cell holds
// "Label: value" ("Board committees: Audit (Chair)"). Find the node
// whose own text is the label, read the parent's collapsed text,
// strip the label prefix. More reliable than slicing the whole card
// on label order — the order isn't fixed across cards.
function amznFieldValue(t, labelRe) {
  for (const e of t.querySelectorAll('*')) {
    const ot = ownText(e);
    if (ot.length < 240 && labelRe.test(ot)) {
      const ptxt = flat(cellText(e.parentNode));
      const m = ptxt.match(new RegExp(labelRe.source + '\\s*(.*)', 'i'));
      if (m && m[1]) return flat(m[1]);
    }
  }
  return '';
}

function extractAmznCard(t) {
  const nameNode = amznNameNodes(t)[0];
  const card = flat(cellText(t));
  const name = flat(cellText(nameNode));
  const ageM = card.match(/Age:\s*(\d{2})/i);
  // Tenure prints as "Director since: July 1994" — keep only the
  // year (the spec stores `since` as a Number, matching the
  // conventional path's MLAB/AAPL output).
  const sinceM = card.match(/Director since:\s*(?:[A-Za-z]+\s+)?((?:19|20)\d{2})/i);
  const commRaw = amznFieldValue(t, /Board committees?:/i);
  const obRaw = amznFieldValue(t, /Other current public company boards?:/i);
  // No reliable inter-item delimiter on AMZN cards: committees are
  // run together with only "(Chair)" as punctuation and boards are
  // space-joined company names. Split on ";" where present (future-
  // proofing other AMZN-family filers); otherwise keep the value as
  // a single best-effort entry. Recall over precision — the gate
  // asserts name/age/since, and over-fitting company-name splits to
  // this one fixture would be dishonest.
  const committees = isNoneVal(commRaw)
    ? []
    : commRaw
        .split(';')
        .map((x) => flat(x).replace(/\s*\(Chair\)\s*$/i, ''))
        .filter((x) => x && !isNoneVal(x));
  const otherBoards = isNoneVal(obRaw)
    ? []
    : (obRaw.includes(';') ? obRaw.split(';') : [obRaw])
        .map((x) => flat(x).replace(/[.;]+$/, ''))
        .filter((x) => x.length > 2 && !isNoneVal(x));
  return {
    name: splitNameTitle(name).name || name,
    age: ageM ? Number(ageM[1]) : null,
    since: sinceM ? Number(sinceM[1]) : null,
    committees,
    otherBoards: [...new Set(otherBoards)],
    bio: amznCardBio(t, name),
  };
}

function extractKoCard(t) {
  const nameNode = koNameNodes(t)[0];
  const card = flat(cellText(t));
  const name = titleCaseName(cellText(nameNode));
  const ageM = card.match(/AGE:\s*(\d{2})/);
  let since = null;
  const sinceB = t
    .querySelectorAll('b')
    .find((b) => /^DIRECTOR SINCE:\s*$/i.test(ownText(b)));
  if (sinceB) {
    const pTxt = flat(cellText(sinceB.parentNode));
    const ym = pTxt.match(/DIRECTOR SINCE:\s*((?:19|20)\d{2})/i);
    if (ym) since = Number(ym[1]);
  }
  // Committees are ";"-delimited up to the next section bar.
  const cm = card.match(
    /COMMITTEES:\s*(.*?)(?:CAREER HIGHLIGHTS|PUBLIC BOARD MEMBERSHIPS|$)/
  );
  const committees = cm && cm[1]
    ? cm[1]
        .split(';')
        .map((x) => flat(x).replace(/\s*\(Chair\)\s*$/i, ''))
        .filter(Boolean)
    : [];
  // Boards are "●"-bulleted under "Current Public Company Boards:".
  // Stop at "Previous ..." (do not merge past boards) and at the
  // registered-funds sub-list some directors carry. Strip the
  // "(since YYYY)" / "(Alternate)" trailers. Best-effort, not gated.
  const seg = card.match(
    /Current Public Company Boards:(.*?)(?:Previous Public Company Boards|Current Boards for Registered|CAREER HIGHLIGHTS|$)/i
  );
  const otherBoards = seg && seg[1]
    ? seg[1]
        .split('●')
        .map((x) =>
          flat(x)
            .replace(/\s*\((?:since[^)]*|Alternate)\)\s*/gi, ' ')
            .replace(/[.;,]+$/, '')
            .trim()
        )
        .filter((x) => x.length > 2 && !isNoneVal(x))
    : [];
  return {
    name,
    age: ageM ? Number(ageM[1]) : null,
    since,
    committees,
    otherBoards: [...new Set(otherBoards)],
    bio: koCardBio(t),
  };
}

// Walk every table in document order (NOT deepest-wins — each card
// is its own table and they're siblings, so all eleven must be
// collected, exactly the rationale behind findTablesBySignature).
// A table is a director card iff it has exactly one styled name node
// of a known family AND that family's since-label in the same table,
// and its collapsed text is bounded (< 4000 chars excludes the
// wrapper/summary/montage tables, which are far larger or carry many
// names). One styled name per table is an invariant of both filers.
function parseBoardCards(root) {
  const out = [];
  for (const t of root.querySelectorAll('table')) {
    const card = flat(cellText(t));
    if (!card || card.length >= 4000) continue;

    const amznNames = amznNameNodes(t);
    if (amznNames.length === 1 && /director since:/i.test(card)) {
      const d = extractAmznCard(t);
      if (d.name) out.push(d);
      continue;
    }
    const koNames = koNameNodes(t);
    if (koNames.length === 1 && koHasDirectorSinceLabel(t)) {
      const d = extractKoCard(t);
      if (d.name) out.push(d);
      continue;
    }
  }
  // Same numeric net the other tiers use as a last guard: a real
  // director has a plausible age or tenure year (or genuinely
  // neither — never drop a real name on that alone).
  return out.filter((d) => {
    const ageOk = d.age === null || (Number.isFinite(d.age) && d.age >= 18 && d.age <= 100);
    const sinceOk =
      d.since === null || (Number.isFinite(d.since) && d.since >= 1900 && d.since <= 2100);
    return d.name && ageOk && sinceOk;
  });
}

export function parseBoard(html) {
  const root = parseHtml(html);
  // Deepest-wins picked whichever board-ish table came last in the
  // document — for a small/mid-cap that's the post-roster governance
  // checkmark table, not the roster. Take every BOARD_SIG match and
  // keep the one whose header genuinely exposes a name column; among
  // those, prefer a clean header row over a prose/glyph blob.
  const picked =
    findTablesBySignature(root, BOARD_SIG)
      .map((cand) => ({ ...cand, h: headerMap(cand.rows[cand.hIdx]) }))
      .find(
        (cand) =>
          cand.h.name !== undefined && looksLikeHeaderRow(cand.rows[cand.hIdx])
      ) || null;
  const out = [];
  if (picked) {
    const all = picked.rows;
    const hIdx = picked.hIdx;
    const h = picked.h;
    // The conventional roster carries no narrative; the one column
    // that reads as a bio is the occupation/position cell — AAPL
    // labels it "Occupation", MLAB "Position(s) with the Company".
    // headerMap deliberately doesn't claim it (it would collide with
    // the SCT's "Name and Principal Position"), so resolve the index
    // here, off the picked header row only. The parenthesised and
    // anchored forms keep "Name and Principal Position" from
    // matching, so no other column is mistaken for it.
    const occIdx = (all[hIdx] || []).findIndex((cell) =>
      /occupation|principal occupation|position\(s\)|^position\b|present principal/i.test(
        String(cell || '')
      )
    );
    if (h.name !== undefined) {
      for (let i = hIdx + 1; i < all.length; i++) {
        const c = all[i];
        // The Name cell is mostly just a name here, but a matrix-style
        // roster (AAPL) glues the chairman's designation onto it —
        // "Art Levinson Board Chair". Run it through the same name/
        // title split the SCT uses so the column reads as people, not
        // titles. The roster carries no title field, so the remainder
        // is dropped; if the split can't find a name (a legend or
        // continuation row that opens with a role word) keep the raw
        // cell and let the age/label guards below reject it — recall
        // over precision, never drop a real director.
        const raw = (c[h.name] || '').replace(/\s+/g, ' ').trim();
        const name = splitNameTitle(raw).name || raw;
        // Age optional (no Age column on many large-caps); strip
        // footnote refs by taking the first digit run.
        const age =
          h.age !== undefined
            ? Number((String(c[h.age] || '').match(/\d+/) || [''])[0])
            : null;
        const ageValid =
          age === null || (Number.isFinite(age) && age >= 18 && age <= 100);
        if (!name || /^name$|^director$/i.test(name) || !ageValid) continue;
        const since =
          h.since !== undefined
            ? Number((String(c[h.since] || '').match(/\b(19|20)\d{2}\b/) || [])[0]) || null
            : null;
        const committees =
          h.committees !== undefined
            ? COMMITTEE_NAMES.filter((cm) => new RegExp(cm, 'i').test(c[h.committees] || ''))
            : COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(c.join(' ')));
        const otherBoards =
          h.otherboards !== undefined
            ? (c[h.otherboards] || '')
                .split(/;|,(?![^()]*\))/)
                .map((s) => s.replace(/\s+/g, ' ').trim().replace(/[.;]$/, ''))
                .filter((s) => s.length > 2 && /^[A-Z]/.test(s) && !/committee|none\b/i.test(s))
            : [];
        out.push({
          name,
          age,
          since,
          committees,
          otherBoards: [...new Set(otherBoards)],
          bio: occIdx >= 0 ? tidyBio(c[occIdx]) : null,
        });
      }
    }
    if (out.length) return out;
  }
  // Fallback: per-director record blocks in the located section text.
  const txt =
    locateSectionText(root, /election of directors|nominees? for director|board of directors/i) ||
    cellText(root);
  const TOKEN = "[A-Z](?:[a-z][A-Za-z'-]*|'[A-Z][a-z][A-Za-z'-]*)";
  const HEAD = new RegExp(
    `(${TOKEN}(?:\\s+(?:[A-Z]\\.|${TOKEN})){1,3})` +
      `(?:,\\s*age\\s*(\\d{2})|,\\s*(\\d{2})(?=\\s*,)|\\s*\\(age\\s*(\\d{2})\\))`,
    'g'
  );
  const heads = [];
  let m;
  while ((m = HEAD.exec(txt)) !== null) {
    heads.push({ name: m[1].trim(), age: Number(m[2] ?? m[3] ?? m[4]), at: m.index });
  }
  const prose = heads
    .map((hd, i) => {
      const w = txt.slice(hd.at, i + 1 < heads.length ? heads[i + 1].at : txt.length);
      const since = (w.match(/(?:director since|since)\s+(?:[A-Za-z]+\s+){0,2}(?:\d{1,2},?\s*)?((?:19|20)\d{2})/i) || [])[1];
      return {
        name: hd.name,
        age: hd.age,
        since: since ? Number(since) : null,
        committees: COMMITTEE_NAMES.filter((cm) => new RegExp(`${cm}\\s+Committee`, 'i').test(w)),
        otherBoards: [],
        // This tier's per-director window IS the bio — the record
        // block between one director header and the next. Keep it
        // whole (capped); it's already the narrative the section
        // carries for that person.
        bio: tidyBio(w),
      };
    })
    .filter((d) => {
      const personName = /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4}$/.test(d.name)
        && !/\b(table|date|page|exhibit|item|note|index|contents)\b/i.test(d.name);
      const ageOk = Number.isFinite(d.age) && d.age >= 18 && d.age <= 100;
      const sinceOk = Number.isFinite(d.since) && d.since >= 1900 && d.since <= 2100;
      return personName && (ageOk || sinceOk);
    });
  if (prose.length) return prose;

  // Last tier: the bespoke per-director bio cards (AMZN, KO). Only
  // reached when neither the conventional roster table nor the
  // section prose yielded a single director, so MLAB and AAPL —
  // which resolve on the table path above — never enter here and
  // stay byte-identical.
  return parseBoardCards(root);
}

const toNum = (s) => {
  const cleaned = String(s == null ? '' : s)
    .replace(/\([\w\d.,]+\)/g, '')   // strip footnote refs e.g. (3) (a) (1,234)
    .replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

// Some proxies (e.g. AMZN) inject a "$" separator cell between the header
// column and the numeric value, so the value sits at headerCol+1 or +2.
// Scan up to 3 positions rightward from the header index to find the first
// non-null numeric; never skip past the next labelled column.
function numFromCol(row, colIdx, nextColIdx) {
  if (colIdx === undefined) return null;
  const limit = nextColIdx !== undefined ? Math.min(colIdx + 3, nextColIdx) : colIdx + 3;
  for (let i = colIdx; i <= limit && i < row.length; i++) {
    const v = toNum(row[i]);
    if (v != null) return v;
  }
  return null;
}

// The "Name and Principal Position" cell is the single most irregular
// field in the whole table. Issuers pack it three different ways: name
// then C-suite title (AAPL "Tim Cook Chief Executive Officer"); name
// then a *non*-"Chief" title the old C-suite regex never saw, like
// "Founder and Executive Chair", "CEO Amazon Web Services", "SVP and
// Chief Financial Officer" (AMZN); or name and title split across
// sibling <tr>s so the title arrives as its own cell with no name at
// all (KO "Chairman of the Board and" on the row below "James
// Quincey"). The footnote marker rides along glued to the surname via
// a <sup> ("James Quincey(2)"). So don't hunt for a known title and
// keep the prefix — that's what mis-cut "Deirdre O'Brien Senior Vice"
// and surfaced title fragments as people. Instead read the *name*: it
// is the leading run of capitalized word/initial tokens, and it ends
// the moment a role word starts (or after four tokens — no executive
// has a five-token name). A cell that opens with a role word or a
// "(a)" column letter has no name at all; we return an empty name so
// the caller skips it as a continuation row rather than minting a
// phantom officer.
//
// The same boundary now also fences the board roster's Name column,
// where the chairman's cell trails a role *designation* rather than a
// C-suite title — AAPL's "Art Levinson Board Chair", or the
// "Chairperson of the Board" / "Lead Independent Director" forms other
// issuers use. "Board", "Lead", "Independent" and "Nominee" are the
// words those designations open with; "Chairperson" is the longer
// chair form the bare chairman|chair pair never matched. They're title
// words, never the first token of a person's name — the same bet the
// list already makes on "Director", "Head" and "Principal".
const ROLE_START =
  /^(chief|president|vice|senior|executive|chair(?:man|person)?|founder|co-?founder|ceo|cfo|coo|cto|cio|svp|evp|vp|general|former|director|head|group|global|principal|treasurer|secretary|managing|interim|deputy|corporate|operating|board|lead|independent|nominee)\b/i;
const NAME_PIECE = /^(?:[A-Z]\.?|[A-Z][A-Za-z'’.-]*)$/;

function splitNameTitle(cell) {
  // Strip footnote markers ("(2)", "(a)", "(3)(4)") wherever they sit;
  // keeps the surname clean and never affects the dollar columns,
  // which are read separately.
  const clean = String(cell || '')
    .replace(/\(\s*[\w.,]{1,6}\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return { name: '', title: '' };

  const tokens = clean.split(' ');
  const name = [];
  let i = 0;
  for (; i < tokens.length && name.length < 4; i++) {
    const t = tokens[i];
    if (ROLE_START.test(t) || !NAME_PIECE.test(t)) break;
    name.push(t);
  }
  const title = tokens.slice(i).join(' ').replace(/^[,;]\s*/, '').trim();
  // No leading name → this is a title-only continuation cell (KO's
  // second/third <tr> per officer) or a column-letter row; signal the
  // caller to skip by returning an empty name, but hand back the text
  // as title so it can be stitched onto the officer above.
  return { name: name.join(' '), title };
}

// Summary Compensation Table, found by header signature anywhere in the
// DOM (TOC-proof). Requires a name column in the signature so a
// table-of-contents/narrative table can't false-positive. Columns are
// read by header index (not position) so blank/extra columns don't
// misalign the mix.
//
// Some proxies (e.g. KO) split column labels across 2–3 header rows:
// one row carries "Salary | Bonus | ... | Total", the adjacent row
// carries "Name and Principal Position | Year | ($) | ($) | ...".
// SCT_SIG_SINGLE handles the single-row case (most issuers); the
// multi-row fallback below merges consecutive rows and maps headers
// from the merged view.
const SCT_SIG_SINGLE = (cells) => {
  const j = cells.join(' | ').toLowerCase();
  return (
    /salary/.test(j) &&
    /\btotal\b/.test(j) &&
    /name|principal position/.test(j) &&
    [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 1
  );
};

// Sliding-window version: returns the index of the first row in a
// window of up to `win` rows (default 4) whose UNION satisfies the
// full SCT signature. Returns { hIdx, merged } where merged is the
// flattened header array and hIdx is the last header row index
// (data starts at hIdx+1).
function findSctHeaderWindow(all, win = 4) {
  for (let start = 0; start < all.length - 1; start++) {
    // Build a merged row from start..start+win-1
    for (let end = start + 1; end < Math.min(start + win, all.length); end++) {
      const merged = [];
      for (let r = start; r <= end; r++) {
        all[r].forEach((v, i) => {
          if (v && v.trim() && v !== '​') merged[i] = (merged[i] ? merged[i] + ' ' : '') + v;
        });
      }
      const j = merged.join(' | ').toLowerCase();
      if (
        /salary/.test(j) &&
        /\btotal\b/.test(j) &&
        /name|principal position/.test(j) &&
        [/bonus/, /stock award/, /option award/, /non-?equity/].filter((re) => re.test(j)).length >= 1
      ) {
        return { hIdx: end, merged };
      }
    }
  }
  return null;
}

export function parseComp(html) {
  const root = parseHtml(html);

  // Primary path: single-row header (AAPL, AMZN, most issuers).
  let table = findTableBySignature(root, SCT_SIG_SINGLE);
  let all = table ? tableRows(table) : [];
  let hIdx = table ? all.findIndex((cells) => SCT_SIG_SINGLE(cells)) : -1;
  let h = hIdx >= 0 ? headerMap(all[hIdx]) : {};

  // Fallback: multi-row header (KO). Try every table; pick the last
  // one with a valid window match (same deepest-wins logic as
  // findTableBySignature).
  if (!table || hIdx < 0 || h.name === undefined || h.total === undefined) {
    let bestTable = null;
    let bestResult = null;
    for (const t of root.querySelectorAll('table')) {
      const rows = tableRows(t);
      const result = findSctHeaderWindow(rows);
      if (result) { bestTable = t; bestResult = result; }
    }
    if (bestTable && bestResult) {
      table = bestTable;
      all = tableRows(table);
      hIdx = bestResult.hIdx;
      h = headerMap(bestResult.merged);
    }
  }

  if (!table || hIdx < 0) return { rows: [] };
  if (h.name === undefined || h.total === undefined) return { rows: [] };

  // Sorted column positions so numFromCol can bound its rightward scan.
  const colOrder = Object.values(h).filter(Number.isFinite).sort((a, b) => a - b);
  const nextCol = (idx) => colOrder.find((pos) => pos > idx);

  const rows = [];
  const seen = new Set();
  for (let i = hIdx + 1; i < all.length; i++) {
    const c = all[i];
    // Name is always text at h.name directly; numeric scan is for dollar columns.
    const nameTxt = (c[h.name] || '').trim();
    if (!nameTxt || /^name|director|^total$/i.test(nameTxt)) continue;
    const total = numFromCol(c, h.total, nextCol(h.total));
    if (!total) continue;
    const { name, title } = splitNameTitle(nameTxt);
    if (!name || seen.has(name)) continue; // first (latest year) row per officer
    seen.add(name);
    // KO and its ilk keep only the name on the officer's first <tr>
    // and spill the title onto the next one or two prior-year rows
    // (their name-cell parses to no person, by construction). When
    // the packed cell gave us nothing, stitch those fragments back
    // on — stop at the next person, a column-letter "(a)" row, or a
    // blank, so we never swallow the following officer's title.
    let fullTitle = title;
    if (!fullTitle) {
      const parts = [];
      for (let k = i + 1; k < all.length && parts.length < 3; k++) {
        const txt = (all[k][h.name] || '').trim();
        if (!txt || /^\(?[a-z]\)?$/i.test(txt)) break;
        const split = splitNameTitle(txt);
        if (split.name) break; // reached the next real officer
        if (split.title) parts.push(split.title);
      }
      fullTitle = parts.join(' ').replace(/\s+/g, ' ').trim();
    }
    const salary = h.salary !== undefined ? numFromCol(c, h.salary, nextCol(h.salary)) : null;
    const stock = h.stock !== undefined ? numFromCol(c, h.stock, nextCol(h.stock)) : null;
    const option = h.option !== undefined ? numFromCol(c, h.option, nextCol(h.option)) : null;
    const haveCols = [salary, stock, option].filter((v) => v != null).length >= 2;
    const pct = (v) => (haveCols && v != null ? Math.round((v / total) * 100) : null);
    const otherPct = haveCols
      ? Math.max(0, Math.round(((total - (salary || 0) - (stock || 0) - (option || 0)) / total) * 100))
      : null;
    rows.push({ name, title: fullTitle, total, salaryPct: pct(salary), stockPct: pct(stock), optionPct: pct(option), otherPct });
  }
  return { rows };
}

// Interlocking directorates, bounded to the fund's own holdings: a
// director of the focus company who also sits on the board of another
// name the fund holds is an edge focus<->thatHolding. Name match is
// loose (case-insensitive substring either direction) — proxy company
// names rarely match the sheet exactly.
function holdingFor(name, holdings) {
  const n = String(name || '').toLowerCase().replace(/[.,]/g, '').trim();
  if (!n) return null;
  for (const h of holdings) {
    const hn = String(h.name || '').toLowerCase().replace(/[.,]/g, '').trim();
    if (hn && (hn.includes(n) || n.includes(hn))) return h.ticker;
  }
  return null;
}

export function buildNetwork(focusTicker, board, holdings) {
  const f = String(focusTicker || '').toUpperCase();
  if (!f || !Array.isArray(board) || !Array.isArray(holdings)) {
    return { nodes: [], edges: [] };
  }
  const nodes = new Set();
  const edges = [];
  for (const d of board) {
    for (const ob of d?.otherBoards || []) {
      const tk = holdingFor(ob, holdings);
      if (tk && tk.toUpperCase() !== f) {
        nodes.add(f);
        nodes.add(tk);
        edges.push({ person: d.name, a: f, b: tk });
      }
    }
  }
  return { nodes: [...nodes], edges };
}
