-- CreateTable
CREATE TABLE "SeaSignal" (
    "date" DATE NOT NULL,
    "signalName" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeaSignal_pkey" PRIMARY KEY ("date","signalName")
);

-- CreateTable
CREATE TABLE "SeaSnapshot" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "vesselCount" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeaSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeaSignal_signalName_date_idx" ON "SeaSignal"("signalName", "date");
