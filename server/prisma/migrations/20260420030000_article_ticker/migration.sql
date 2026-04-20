-- Record the ticker context under which each article was first seen. Used
-- by the Week in Review generator to exclude news fetched via broad-market
-- ETF lookups (VOO, QQQ, etc.) — those headlines are category-wide and
-- don't represent news about the club's specific holdings.
ALTER TABLE "ArticleRanking" ADD COLUMN "ticker" TEXT;
CREATE INDEX "ArticleRanking_ticker_idx" ON "ArticleRanking"("ticker");
