-- Add optional investmentAmount to Ballot. Required at the API layer when
-- action = 'Buy' (range: 1500–10000) and nullable for Hold/Sell. Existing
-- rows are left NULL.
ALTER TABLE "Ballot" ADD COLUMN "investmentAmount" DOUBLE PRECISION;
