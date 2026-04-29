-- Add per-request start time + room to PitchRequest. Both are nullable
-- so existing rows in production stay valid; the route enforces presence
-- on the new submission flow.

ALTER TABLE "PitchRequest"
  ADD COLUMN "proposedStartTime" TEXT,
  ADD COLUMN "room" TEXT;
