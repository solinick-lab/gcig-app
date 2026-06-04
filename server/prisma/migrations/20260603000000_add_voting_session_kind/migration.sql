-- A VotingSession is now one of two kinds. "buy" is the original pitch
-- vote (Buy/Hold/Sell with a proposed allocation); "sell" is a vote to
-- exit a holding we already own (Sell/Hold, no dollar amount). Additive
-- with a default so every existing session reads as a buy vote — no
-- backfill, no data touched.
ALTER TABLE "VotingSession" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'buy';
