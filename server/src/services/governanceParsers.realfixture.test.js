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
  });
}
