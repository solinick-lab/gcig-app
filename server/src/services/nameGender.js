import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Name → gender inference backed by a US-Census-style frequency dataset
// (name_gender.csv, ~147K rows). Used across the app for:
//   - honorific greetings ("Mr. Seirer")
//   - pronouns in drafted messages (the AI Assistant)
//   - tinting avatar monograms on Landing + Members
//
// Hard truths to remember everywhere this is consumed:
//   - Name-based gender inference is wrong some of the time. International
//     names, nicknames, and unisex names can flip wrong. Always treat the
//     confidence score as a gate — below ~0.85 we refuse to guess.
//   - Pronouns from gender guess are never authoritative. If the user
//     later tells us their actual pronouns we should store + prefer that.
//     For now this is a best-effort default.
//   - Never EXPOSE the guessed gender to the member themselves (showing
//     someone "we think you're a man" is creepy). It's an internal signal
//     for tinting / honorifics / pronouns, nothing more.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSV_PATH = path.join(__dirname, '..', 'data', 'name_gender.csv');

// Parsed lookup: upper-cased first name → { gender: 'M' | 'F', confidence: 0..1 }.
// Built lazily on first call, then cached for the life of the process.
let table = null;

function loadTable() {
  if (table) return table;
  const start = Date.now();
  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  // Accumulator: NAME → { M: count, F: count }
  const counts = new Map();
  const lines = raw.split('\n');
  // Skip the header row (Name,Gender,Count,Probability).
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Simple CSV split — the dataset has no quoted fields.
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const name = parts[0].trim().toUpperCase();
    const gender = parts[1].trim().toUpperCase();
    const n = Number(parts[2]);
    if (!name || (gender !== 'M' && gender !== 'F') || !Number.isFinite(n)) continue;
    const entry = counts.get(name) || { M: 0, F: 0 };
    entry[gender] += n;
    counts.set(name, entry);
  }
  // Collapse to { gender, confidence } with whichever count dominates.
  const result = new Map();
  for (const [name, c] of counts) {
    const total = c.M + c.F;
    if (total === 0) continue;
    if (c.M >= c.F) {
      result.set(name, { gender: 'M', confidence: c.M / total });
    } else {
      result.set(name, { gender: 'F', confidence: c.F / total });
    }
  }
  table = result;
  const elapsed = Date.now() - start;
  console.log(`nameGender: loaded ${table.size} entries in ${elapsed}ms`);
  return table;
}

// Minimum confidence we require before asserting Mr./Ms. or binary
// pronouns. Below this we use the neutral fallback (Mx. / they-them).
// 0.85 trades off coverage against correctness — hand-picked to cover
// names like "Cole" (0.996 M) but refuse on "Alex" / "Jordan" / "Taylor".
const CONFIDENCE_FLOOR = 0.85;

// Strip a leading name into the first token + the most useful "last"
// token. Handles multi-part first names ("Mary Jane") and preserves
// the last surname when the name has middle initials ("John Q. Smith"
// → first "John", last "Smith"). Best-effort — not every name fits.
function splitName(fullName) {
  if (!fullName || typeof fullName !== 'string') return { first: '', last: '' };
  const tokens = fullName
    .replace(/["“”]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return { first: '', last: '' };
  if (tokens.length === 1) return { first: tokens[0], last: '' };
  return { first: tokens[0], last: tokens[tokens.length - 1] };
}

export function guessGender(firstName) {
  if (!firstName) return { gender: 'U', confidence: 0 };
  const t = loadTable();
  const key = String(firstName).trim().toUpperCase();
  if (!key) return { gender: 'U', confidence: 0 };
  const row = t.get(key);
  if (!row) return { gender: 'U', confidence: 0 };
  return { gender: row.gender, confidence: row.confidence };
}

// Pronoun triplet. Defaults to they/them when we can't confidently guess.
// Subject is the nominative form ("he/she/they"), object the accusative
// ("him/her/them"), possessive the genitive ("his/her/their").
export function guessPronouns(firstName) {
  const { gender, confidence } = guessGender(firstName);
  if (confidence < CONFIDENCE_FLOOR) {
    return { subject: 'they', object: 'them', possessive: 'their' };
  }
  if (gender === 'M') return { subject: 'he', object: 'him', possessive: 'his' };
  if (gender === 'F') return { subject: 'she', object: 'her', possessive: 'her' };
  return { subject: 'they', object: 'them', possessive: 'their' };
}

// Honorific prefix. Returns "Mr." / "Ms." on high-confidence guesses,
// "Mx." (gender-neutral) otherwise. Callers can treat "Mx." as "we
// couldn't confidently guess" and fall back to first-name greetings.
export function guessHonorific(firstName) {
  const { gender, confidence } = guessGender(firstName);
  if (confidence < CONFIDENCE_FLOOR) return 'Mx.';
  if (gender === 'M') return 'Mr.';
  if (gender === 'F') return 'Ms.';
  return 'Mx.';
}

// "Mr. Seirer" / "Ms. Smith" — honorific + surname. Returns null when
// the guess would be Mx. or when the name doesn't split into first +
// last cleanly. Callers should fall back to the first name in that case.
export function honorificName(fullName) {
  const { first, last } = splitName(fullName);
  if (!first || !last) return null;
  const honorific = guessHonorific(first);
  if (honorific === 'Mx.') return null;
  return `${honorific} ${last}`;
}

// One-shot profile for a member. Never throws, always returns a
// consistent shape even when the name can't be resolved.
export function nameProfile(fullName) {
  const { first, last } = splitName(fullName);
  const { gender, confidence } = guessGender(first);
  const pronouns = guessPronouns(first);
  const honorific = guessHonorific(first);
  const confident = confidence >= CONFIDENCE_FLOOR;
  return {
    firstName: first || null,
    lastName: last || null,
    // 'M' | 'F' | 'U' — only 'M'/'F' when confidence passes the floor.
    gender: confident && (gender === 'M' || gender === 'F') ? gender : 'U',
    confidence: Number(confidence.toFixed(3)),
    pronouns,
    honorific: confident && honorific !== 'Mx.' ? honorific : null,
    // Full "Mr. Seirer" string, or null if we can't form it confidently
    // or the name doesn't have a last token.
    honorificName: honorificName(fullName),
  };
}
