-- CreateTable
CREATE TABLE "HoldingThesis" (
    "id"            SERIAL NOT NULL,
    "ticker"        TEXT NOT NULL,
    "thesis"        TEXT NOT NULL,
    "updatedByName" TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HoldingThesis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HoldingThesis_ticker_key" ON "HoldingThesis"("ticker");
