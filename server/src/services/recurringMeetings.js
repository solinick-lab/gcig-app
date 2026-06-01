import prisma from '../db.js';

// Hard-coded recurring club meetings. On server startup, we ensure that
// every expected instance exists as a real row in the `Event` table with
// `recurring: true`, so they show up in the calendar AND are markable
// for attendance just like any other event.
//
// `ensureRecurringMeetings` is BOTH additive and destructive:
//   - missing expected instances are created
//   - existing recurring rows that no longer match the schedule (because
//     we moved startDate forward, added a skipDate, or retired a title)
//     are deleted, taking their Attendance rows with them via cascade.
// Recurring meetings aren't editable through the UI (events.js refuses
// both PUT and DELETE on recurring=true rows), so there are no manual
// tweaks to preserve — the code is the source of truth.

const RECURRING_MEETINGS = [
  {
    title: 'Griffin Fund Weekly Meeting',
    dayOfWeek: 3, // Wednesday (0 = Sun)
    startHour: 13, // 1 PM
    startMinute: 50,
    durationMinutes: 30, // 1:50 – 2:20 PM
    location: null,
    description: 'Weekly club meeting (1:50 – 2:20 PM)',
    // First real club meeting (Apr 15, 2026). Anything earlier in the
    // DB is a leftover from the initial 3-month backfill and gets
    // pruned on startup. The Apr 15 row itself stays — it matches the
    // generated schedule — so its attendance records survive.
    startDate: new Date('2026-04-15T00:00:00'),
    // One-off cancellations as YYYY-MM-DD (local). Instances on these
    // dates are neither created nor kept.
    //   2026-04-22 — no meeting that week.
    skipDates: ['2026-04-22'],
  },
];

// How far back / forward to keep recurring instances in the DB.
const MONTHS_BACK = 3;
const MONTHS_FORWARD = 12;

function localDateKey(d) {
  // YYYY-MM-DD in the server's local timezone — matches how skipDates
  // are written by humans (no TZ math required).
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildInstances() {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setMonth(windowStart.getMonth() - MONTHS_BACK);
  windowStart.setHours(0, 0, 0, 0);
  const windowEnd = new Date(now);
  windowEnd.setMonth(windowEnd.getMonth() + MONTHS_FORWARD);

  const instances = [];
  for (const m of RECURRING_MEETINGS) {
    // Cursor begins at whichever is later: the schedule's startDate or
    // the rolling window's back edge.
    const lowerBound =
      m.startDate && m.startDate > windowStart ? new Date(m.startDate) : new Date(windowStart);
    const cursor = new Date(lowerBound);
    cursor.setHours(m.startHour, m.startMinute, 0, 0);
    const offset = (m.dayOfWeek - cursor.getDay() + 7) % 7;
    cursor.setDate(cursor.getDate() + offset);

    const skipSet = new Set(m.skipDates || []);
    while (cursor <= windowEnd) {
      if (!skipSet.has(localDateKey(cursor))) {
        instances.push({
          title: m.title,
          date: new Date(cursor),
          location: m.location,
          description: m.description,
          durationMinutes: m.durationMinutes,
          recurring: true,
        });
      }
      cursor.setDate(cursor.getDate() + 7);
    }
  }
  return instances;
}

/**
 * Ensures every expected recurring meeting exists in the DB, and prunes
 * any recurring rows that are no longer in the expected set (e.g. past
 * phantom instances from before startDate, or cancelled skipDates).
 * Attendance rows cascade-delete with their event per the Prisma schema.
 */
export async function ensureRecurringMeetings() {
  const expected = buildInstances();
  const managedTitles = Array.from(new Set(RECURRING_MEETINGS.map((m) => m.title)));
  if (managedTitles.length === 0) return;

  const existing = await prisma.event.findMany({
    where: {
      recurring: true,
      title: { in: managedTitles },
    },
    select: { id: true, title: true, date: true },
  });

  const expectedKey = new Set(
    expected.map((e) => `${e.title}::${e.date.toISOString()}`)
  );
  const existingKey = new Set(
    existing.map((e) => `${e.title}::${new Date(e.date).toISOString()}`)
  );

  // Prune: recurring rows whose (title, date) no longer matches the
  // expected schedule. Cascades to Attendance.
  const toDeleteIds = existing
    .filter((e) => !expectedKey.has(`${e.title}::${new Date(e.date).toISOString()}`))
    .map((e) => e.id);
  if (toDeleteIds.length > 0) {
    await prisma.event.deleteMany({ where: { id: { in: toDeleteIds } } });
    console.log(`Pruned ${toDeleteIds.length} stale recurring meeting instance(s).`);
  }

  // Create: expected instances not yet in the DB.
  const toCreate = expected.filter(
    (e) => !existingKey.has(`${e.title}::${e.date.toISOString()}`)
  );
  if (toCreate.length > 0) {
    await prisma.event.createMany({ data: toCreate });
    console.log(`Ensured ${toCreate.length} new recurring meeting instance(s).`);
  }
}
