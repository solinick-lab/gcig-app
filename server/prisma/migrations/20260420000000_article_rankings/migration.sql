-- Persisted LLM rankings for news articles, keyed by URL. Lets the article
-- ranker skip the LLM entirely for URLs it has already classified.
CREATE TABLE "ArticleRanking" (
    "id" SERIAL NOT NULL,
    "url" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "reason" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleRanking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArticleRanking_url_key" ON "ArticleRanking"("url");
CREATE INDEX "ArticleRanking_createdAt_idx" ON "ArticleRanking"("createdAt");
