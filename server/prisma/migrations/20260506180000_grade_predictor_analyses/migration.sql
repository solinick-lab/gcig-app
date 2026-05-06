-- CreateTable
CREATE TABLE "GradePredictorAnalysis" (
    "id" SERIAL NOT NULL,
    "teacher" TEXT,
    "essay" TEXT NOT NULL,
    "rubric" TEXT,
    "result" JSONB NOT NULL,
    "gradeLabel" TEXT,
    "numericGrade" INTEGER,
    "confidence" TEXT,
    "examplesUsed" INTEGER NOT NULL DEFAULT 0,
    "examplesAvailable" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT,
    "essayFileRef" TEXT,
    "essayFileUrl" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradePredictorAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GradePredictorAnalysis_createdById_createdAt_idx" ON "GradePredictorAnalysis"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "GradePredictorAnalysis_teacher_idx" ON "GradePredictorAnalysis"("teacher");

-- AddForeignKey
ALTER TABLE "GradePredictorAnalysis" ADD CONSTRAINT "GradePredictorAnalysis_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
