// Lunch-block schedule + helpers for the Request-a-Pitch feature.
// Identical copy lives at client/src/lib/lunchSlots.js — keep them in
// sync (small enough that a shared module isn't worth the build setup).
//
// Schedule:
//   Mon/Tue/Thu/Fri  First  12:00–13:00  (selectable start 12:00–12:45)
//                    Second 13:00–14:00  (selectable start 13:00–13:45)
//   Wed              First  11:50–12:50  (selectable start 11:50–12:35)
//                    Second 12:50–13:50  (selectable start 12:50–13:35)
//
// Members can't pick a start time more than 45 minutes into a lunch
// block — anything later doesn't leave room for a meaningful meeting.

const SLOT_INCREMENT_MIN = 5;
const MAX_OFFSET_MIN = 45;

// { weekday: { First: 'HH:MM', Second: 'HH:MM' } } — block start times.
const BLOCK_STARTS = {
  mon: { First: '12:00', Second: '13:00' },
  tue: { First: '12:00', Second: '13:00' },
  wed: { First: '11:50', Second: '12:50' },
  thu: { First: '12:00', Second: '13:00' },
  fri: { First: '12:00', Second: '13:00' },
};

export const ROOM_VALUES = ['LIBRARY', 'LOWER_COMMONS', 'ATHLETIC_COMMONS'];
export const ROOM_LABELS = {
  LIBRARY: 'Library (near smart board / printers)',
  LOWER_COMMONS: 'Lower Commons',
  ATHLETIC_COMMONS: 'Athletic Commons',
};

// Returns the weekday key (mon..fri) for a "YYYY-MM-DD" or ISO date
// string. Uses UTC accessors so a "2026-04-29" string from a
// <input type="date"> always resolves to Wednesday regardless of the
// caller's local timezone (the input parses as UTC midnight; in ET
// that's 8 PM the day before, which would otherwise flip the weekday).
// Null on invalid input or a weekend.
export function weekdayKeyFor(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay();
  const key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day];
  return key in BLOCK_STARTS ? key : null;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function fromMinutes(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Generates an array of "HH:MM" slot strings starting at the lunch
// block's start, in 5-min increments, ending at start+45 minutes
// (inclusive). Empty array on weekend / invalid lunch period.
export function generateLunchSlots(weekday, lunch) {
  if (!weekday || !BLOCK_STARTS[weekday]) return [];
  if (lunch === 'Both' || !lunch) {
    // Union of First + Second (de-duped, sorted) so requesters who
    // didn't commit to a block can still pick a concrete time.
    const a = generateLunchSlots(weekday, 'First');
    const b = generateLunchSlots(weekday, 'Second');
    const set = new Set([...a, ...b]);
    return [...set].sort();
  }
  const startStr = BLOCK_STARTS[weekday][lunch];
  if (!startStr) return [];
  const startMin = toMinutes(startStr);
  const slots = [];
  for (let m = 0; m <= MAX_OFFSET_MIN; m += SLOT_INCREMENT_MIN) {
    slots.push(fromMinutes(startMin + m));
  }
  return slots;
}

export function isValidSlot(weekday, lunch, hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return false;
  return generateLunchSlots(weekday, lunch).includes(hhmm);
}

// Pretty-print a 24h "HH:MM" string as "12:15 PM". Returns the input
// unchanged if it doesn't match the expected format.
export function formatStartTime(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm || '')) return hhmm || '';
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

export function isValidRoom(room) {
  return ROOM_VALUES.includes(room);
}
