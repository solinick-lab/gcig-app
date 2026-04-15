import prisma from '../db.js';

// Hard-coded recurring club meetings. On server startup, we ensure that
// every expected instance exists as a real row in the `Event` table with
// `recurring: true`, so they show up in the calendar AND are markable
// for attendance just like any other event.

const RECURRING_MEETINGS = [
  {
    title: 'GCIG Weekly Meeting',
    dayOfWeek: 3, // Wednesday (0 = Sun)
    startHour: 13, // 1 PM
    startMinute: 50,
    durationMinutes: 30, // 1:50 – 2:20 PM
    location: null,
    description: 'Weekly club meeting (1:50 – 2:20 PM)',
  },
];

// How far back / forward to keep recurring instances in the DB.
const MONTHS_BACK = 3;
const MONTHS_FORWARD = 12;

function buildInstances() {
  const now = new Date();
  const from = new Date(now);
  from.setMonth(from.getMonth() - MONTHS_BACK);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setMonth(to.getMonth() + MONTHS_FORWARD);

  const instances = [];
  for (const m of RECURRING_MEETINGS) {
    const cursor = new Date(from);
    cursor.setHours(m.startHour, m.startMinute, 0, 0);
    const offset = (m.dayOfWeek - cursor.getDay() + 7) % 7;
    cursor.setDate(cursor.getDate() + offset);

    while (cursor <= to) {
      instances.push({
        title: m.title,
        date: new Date(cursor),
        location: m.location,
        description: m.description,
        durationMinutes: m.durationMinutes,
        recurring: true,
      });
      cursor.setDate(cursor.getDate() + 7);
    }
  }
  return instances;
}

/**
 * Ensures every expected recurring meeting exists in the DB.
 * Creates missing instances; leaves existing ones untouched so manual
 * edits (e.g. adding a location) are preserved.
 */
export async function ensureRecurringMeetings() {
  const expected = buildInstances();
  if (expected.length === 0) return;

  // Find existing recurring rows in the same window for dedup.
  const titles = Array.from(new Set(expected.map((e) => e.title)));
  const existing = await prisma.event.findMany({
    where: {
      recurring: true,
      title: { in: titles },
    },
    select: { title: true, date: true },
  });

  const existingKey = new Set(
    existing.map((e) => `${e.title}::${new Date(e.date).toISOString()}`)
  );

  const toCreate = expected.filter(
    (e) => !existingKey.has(`${e.title}::${e.date.toISOString()}`)
  );

  if (toCreate.length > 0) {
    await prisma.event.createMany({ data: toCreate });
    console.log(`Ensured ${toCreate.length} new recurring meeting instance(s).`);
  }
}
