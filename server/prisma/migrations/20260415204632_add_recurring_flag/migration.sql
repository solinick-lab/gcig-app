-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "durationMinutes" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "recurring" BOOLEAN NOT NULL DEFAULT false;
