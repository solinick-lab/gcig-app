-- A Buy session can now size the trade two ways. "average" (the default,
-- and how every existing session behaves) lets each Buy voter propose a
-- dollar figure and we trade the mean. "fixed" pins the number up front:
-- the creator names the amount and members only ratify it. The pinned
-- figure lives in "fixedAmount", null in average mode. Both columns are
-- additive with safe defaults, so no existing session is touched.
ALTER TABLE "VotingSession" ADD COLUMN "amountMode" TEXT NOT NULL DEFAULT 'average';
ALTER TABLE "VotingSession" ADD COLUMN "fixedAmount" DOUBLE PRECISION;
