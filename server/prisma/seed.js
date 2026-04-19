import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// One-off snapshot corrections. Google's CSV export served stale data for a
// stretch in Apr 2026, so the auto-written snapshots for those days are wrong.
// These overrides fix the rows we have verified values for. Adding a new entry
// here will upsert it on the next deploy — safe to re-run.
const SNAPSHOT_CORRECTIONS = [
  { date: '2026-04-16', totalValue: 130170.36 },
  { date: '2026-04-17', totalValue: 132239.81 },
];

// Historical pitches that were voted down — we don't have the ballot-level
// data, just the final decision. Match each known pitch by ticker + approx
// date and stamp `votedOutcome = 'NoBuy'`. Idempotent.
const NO_BUY_PITCHES = [
  { ticker: 'INTU', date: '2026-01-28' },
  { ticker: 'KSA', date: '2025-12-17' },
  { ticker: 'CRM', date: '2025-11-12' },
  { ticker: 'ARMCO', date: '2026-03-05' },
  { ticker: 'AXON', date: '2025-11-19' },
];

async function seedNoBuyOutcomes() {
  for (const p of NO_BUY_PITCHES) {
    const start = new Date(`${p.date}T00:00:00Z`);
    const end = new Date(`${p.date}T23:59:59Z`);
    const match = await prisma.pitch.findFirst({
      where: {
        ticker: { equals: p.ticker, mode: 'insensitive' },
        date: { gte: start, lte: end },
      },
    });
    if (!match) {
      console.log(`NoBuy seed: pitch ${p.ticker} on ${p.date} not found — skipping`);
      continue;
    }
    if (match.votedOutcome === 'NoBuy') continue;
    await prisma.pitch.update({
      where: { id: match.id },
      data: { votedOutcome: 'NoBuy' },
    });
    console.log(`Marked pitch ${p.ticker} (${p.date}) as NoBuy`);
  }
}

async function seedSnapshotCorrections() {
  for (const c of SNAPSHOT_CORRECTIONS) {
    const date = new Date(`${c.date}T00:00:00Z`);
    await prisma.portfolioSnapshot.upsert({
      where: { date },
      update: { totalValue: c.totalValue },
      create: { date, totalValue: c.totalValue },
    });
    console.log(`Corrected snapshot: ${c.date} -> $${c.totalValue.toLocaleString()}`);
  }
}

// Known historical lots. Seeded once per ticker; if a matching row is already
// present (same ticker + shares + pricePerShare + buyDate), we leave it alone.
const INITIAL_LOTS = [
  // MLAB — Mesa Laboratories
  {
    ticker: 'MLAB',
    shares: 68,
    pricePerShare: 72.94,
    buyDate: new Date('2025-10-17T00:00:00Z'),
  },
  {
    ticker: 'MLAB',
    shares: 53,
    pricePerShare: 100.44,
    buyDate: new Date('2026-04-14T00:00:00Z'),
  },
];

async function seedLots() {
  for (const lot of INITIAL_LOTS) {
    const existing = await prisma.holdingLot.findFirst({
      where: {
        ticker: lot.ticker,
        shares: lot.shares,
        pricePerShare: lot.pricePerShare,
        buyDate: lot.buyDate,
      },
    });
    if (existing) continue;
    await prisma.holdingLot.create({ data: lot });
    console.log(
      `Seeded lot: ${lot.ticker} ${lot.shares} sh @ $${lot.pricePerShare} on ${lot.buyDate.toISOString().slice(0, 10)}`
    );
  }
}

async function main() {
  const email = 'wseirer@gcschool.org';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
    const user = await prisma.user.create({
      data: {
        name: 'Thomas Seirer',
        email,
        passwordHash,
        role: 'President',
      },
    });
    console.log(`Seeded President account:`);
    console.log(`  email:    ${user.email}`);
    console.log(`  password: ChangeMe123!`);
    console.log(`  role:     ${user.role}`);
    console.log(`\nRotate the password after first login.`);
  } else {
    console.log(`President account already exists: ${email}`);
  }

  await seedLots();
  await seedSnapshotCorrections();
  await seedNoBuyOutcomes();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
