-- Switch ranking from a 3-tier priority string to a 0-10 decimal score.
-- Also adds a summary column for article-level AI summaries that are
-- generated lazily when a user opens the reader.
--
-- priority stays around (nullable now) for backwards compatibility; older
-- rows will have priority set but no score, and the ranker fills in a
-- fallback score on read so nothing breaks.
ALTER TABLE "ArticleRanking" ALTER COLUMN "priority" DROP NOT NULL;
ALTER TABLE "ArticleRanking" ADD COLUMN "score" DOUBLE PRECISION;
ALTER TABLE "ArticleRanking" ADD COLUMN "summary" TEXT;
