-- CreateEnum
CREATE TYPE "PitchRequestStatus" AS ENUM ('Pending', 'Approved', 'Declined');

-- CreateEnum
CREATE TYPE "LunchPeriod" AS ENUM ('First', 'Second', 'Both');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lunchSchedule" JSONB;

-- CreateTable
CREATE TABLE "PitchRequest" (
    "id" SERIAL NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "ticker" TEXT NOT NULL,
    "companyName" TEXT,
    "thesis" TEXT,
    "industryId" INTEGER,
    "pmId" INTEGER,
    "proposedDate" TIMESTAMP(3),
    "proposedLunch" "LunchPeriod",
    "notes" TEXT,
    "deckRef" TEXT NOT NULL,
    "status" "PitchRequestStatus" NOT NULL DEFAULT 'Pending',
    "presidentId" INTEGER,
    "presidentDecidedAt" TIMESTAMP(3),
    "presidentDeclineReason" TEXT,
    "pmDecidedAt" TIMESTAMP(3),
    "pmApproved" BOOLEAN,
    "pmDeclineReason" TEXT,
    "requesterSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PitchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PitchRequest_status_createdAt_idx" ON "PitchRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PitchRequest_requesterId_idx" ON "PitchRequest"("requesterId");

-- AddForeignKey
ALTER TABLE "PitchRequest" ADD CONSTRAINT "PitchRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchRequest" ADD CONSTRAINT "PitchRequest_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchRequest" ADD CONSTRAINT "PitchRequest_pmId_fkey" FOREIGN KEY ("pmId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PitchRequest" ADD CONSTRAINT "PitchRequest_presidentId_fkey" FOREIGN KEY ("presidentId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
