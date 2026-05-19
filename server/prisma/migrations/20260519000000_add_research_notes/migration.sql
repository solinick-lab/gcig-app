-- Private per-member research note on a ticker. One row per (user,
-- ticker), upserted on save and visible only to its owner. Cascade from
-- User so deleting an account also clears that member's notes. Additive
-- and append-only: a brand-new table, no existing data is touched.
CREATE TABLE "ResearchNote" (
  "id"        SERIAL PRIMARY KEY,
  "userId"    INTEGER NOT NULL,
  "ticker"    TEXT NOT NULL,
  "body"      TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResearchNote_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ResearchNote_userId_ticker_key"
  ON "ResearchNote"("userId", "ticker");
CREATE INDEX "ResearchNote_userId_idx"
  ON "ResearchNote"("userId");
