-- CreateTable
CREATE TABLE "BenchmarkSnapshot" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'close',

    CONSTRAINT "BenchmarkSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BenchmarkSnapshot_ticker_date_key" ON "BenchmarkSnapshot"("ticker", "date");

-- CreateIndex
CREATE INDEX "BenchmarkSnapshot_ticker_date_idx" ON "BenchmarkSnapshot"("ticker", "date");
