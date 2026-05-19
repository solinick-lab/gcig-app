// New-York wall-clock <-> UTC for datetime-local inputs.
//
// Why this file exists: pitch/event/vote dates live in Postgres as
// UTC and come back over the wire as ISO strings ending in `Z`. The
// edit flow used to do `new Date(value).toISOString().slice(0,16)`
// to fill a `<input type="datetime-local">` and then
// `new Date(form.date).toISOString()` to save it. `toISOString()` is
// UTC, so the input showed UTC digits (four hours ahead of New York
// in summer); on save the browser parsed that zoneless string as
// *local* time and re-encoded to UTC. Populate and save were not
// inverses, so every edit -> save with no real change shoved the
// stored instant forward by the Eastern offset — +4h under EDT, +5h
// under EST, compounding each round.
//
// The fix is one pair of pure, dependency-free functions that both
// speak America/New_York and undo each other exactly. `date-fns-tz`
// is deliberately not a dependency; the built-in Intl time-zone
// formatter already knows the US DST rules, so we derive the offset
// from it instead of shipping a tz database.

// One reusable formatter. `formatToParts` over a fixed zone gives us
// that instant's New-York civil time; we never trust the host zone.
const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Pull the civil fields out of a formatToParts run as numbers. Intl
// has a long-standing quirk where midnight under hour12:false comes
// back as '24' rather than '00'; normalise it so day arithmetic and
// the assembled string stay sane.
function etParts(date) {
  const map = {};
  for (const p of ET.formatToParts(date)) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
  };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Given a Date / ISO string / anything `new Date()` accepts, return
// the America/New_York wall clock as the `YYYY-MM-DDTHH:mm` string a
// datetime-local input expects. Invalid or empty input yields '' so
// the caller can drop it straight into a controlled input without a
// guard. Never throws — populate runs on whatever the API returned.
export function utcIsoToEtInputValue(input) {
  if (input == null || input === '') return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const p = etParts(date);
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}`
  );
}

// Given a `YYYY-MM-DDTHH:mm` string typed into a datetime-local input
// and *meant* as New-York wall-clock, return the matching UTC instant
// as a `…Z` ISO string. Invalid or empty input yields null. Never
// throws — save runs on whatever is sitting in the form.
//
// The offset-derivation (the standard tz-offset trick): treat the
// typed fields as if they were already UTC and call that
// `provisional`. Format an instant back through the New-York Intl
// formatter to see what civil time New York shows there, reassemble
// *that* as a UTC number, and the gap from the instant we formatted
// is New York's offset at that point — Intl picked the DST rule for
// us. Subtracting that offset from `provisional` lands on the true
// instant.
//
// One subtlety forces a second pass. Near a DST change the offset
// sampled at `provisional` can belong to the wrong side of the
// transition (e.g. the autumn fall-back: a 4:15 AM EST wall time
// read as 04:15 UTC still sees EDT, off by an hour). So we sample
// the offset again at the first candidate and re-apply it. Outside
// the literal spring-forward gap / fall-back overlap minute this
// converges, making the function the exact inverse of
// utcIsoToEtInputValue for every round-trippable instant.
function etOffsetMsAt(utcMs) {
  const p = etParts(new Date(utcMs));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - utcMs;
}

export function etInputValueToUtcIso(localStr) {
  if (typeof localStr !== 'string' || localStr === '') return null;
  const m = localStr.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);

  const provisional = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(provisional)) return null;

  // First guess from the offset at the provisional instant, then
  // refine using the offset at that guess so a near-transition
  // sample on the wrong side of DST is corrected.
  const firstGuess = provisional - etOffsetMsAt(provisional);
  const trueInstant = provisional - etOffsetMsAt(firstGuess);
  return new Date(trueInstant).toISOString();
}
