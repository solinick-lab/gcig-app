-- CreateTable
CREATE TABLE "GradePredictorExample" (
    "id" SERIAL NOT NULL,
    "teacher" TEXT,
    "essay" TEXT NOT NULL,
    "rubric" TEXT,
    "feedback" TEXT NOT NULL,
    "grade" TEXT NOT NULL,
    "predictedGrade" TEXT,
    "predictedFeedback" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GradePredictorExample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GradePredictorExample_teacher_idx" ON "GradePredictorExample"("teacher");

-- CreateIndex
CREATE INDEX "GradePredictorExample_createdAt_idx" ON "GradePredictorExample"("createdAt");

-- AddForeignKey
ALTER TABLE "GradePredictorExample" ADD CONSTRAINT "GradePredictorExample_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
