-- CreateTable
CREATE TABLE "FileSummary" (
    "id" SERIAL NOT NULL,
    "fileRef" TEXT NOT NULL,
    "filename" TEXT,
    "summary" TEXT NOT NULL,
    "model" TEXT,
    "charCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FileSummary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FileSummary_fileRef_key" ON "FileSummary"("fileRef");
