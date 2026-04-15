import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'president@gcig.local';
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`President account already exists: ${email}`);
    return;
  }

  const passwordHash = await bcrypt.hash('ChangeMe123!', 10);
  const user = await prisma.user.create({
    data: {
      name: 'Club President',
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
