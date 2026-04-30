-- CreateTable
CREATE TABLE "CpiForecast" (
    "id" SERIAL NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "asOfMonth" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CpiForecast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CpiForecast_asOfMonth_key" ON "CpiForecast"("asOfMonth");

-- CreateIndex
CREATE INDEX "CpiForecast_runAt_idx" ON "CpiForecast"("runAt");
