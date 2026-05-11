-- End-of-year president-performance review. Members rate each President
-- 1-5 on nine statements (stored together as a JSON map keyed by q1..q9)
-- plus an optional free-form comment. One row per reviewer x president x
-- cycle (resubmits upsert). Results are aggregated for the super-admin
-- only; reviewer identity never appears in the aggregate view.
CREATE TABLE "PresidentReview" (
  "id"          SERIAL PRIMARY KEY,
  "reviewerId"  INTEGER NOT NULL,
  "presidentId" INTEGER NOT NULL,
  "cycle"       TEXT NOT NULL,
  "ratings"     JSONB NOT NULL,
  "comment"     TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PresidentReview_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PresidentReview_presidentId_fkey"
    FOREIGN KEY ("presidentId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PresidentReview_reviewerId_presidentId_cycle_key"
  ON "PresidentReview"("reviewerId", "presidentId", "cycle");
CREATE INDEX "PresidentReview_presidentId_cycle_idx"
  ON "PresidentReview"("presidentId", "cycle");
