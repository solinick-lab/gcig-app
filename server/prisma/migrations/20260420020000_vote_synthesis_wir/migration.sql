-- Cache the LLM-generated recap of a closed voting session on the session
-- itself. Filled lazily the first time a closed session is viewed; null
-- on open sessions (recap doesn't make sense until voting is done).
ALTER TABLE "VotingSession" ADD COLUMN "synthesis" TEXT;
