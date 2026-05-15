-- Daily OHLCV cache for the Terminal GP chart and future screener / total-return
-- features. Lazy-backfilled on first sighting of a ticker (5y), then topped up
-- by the daily price-cache cron in src/index.js. Unique (ticker, date) lets the
-- service do per-row upserts without duplicate rows.
CREATE TABLE "PriceBar" (
  "id"        SERIAL PRIMARY KEY,
  "ticker"    TEXT NOT NULL,
  "date"      DATE NOT NULL,
  "open"      DOUBLE PRECISION,
  "high"      DOUBLE PRECISION,
  "low"       DOUBLE PRECISION,
  "close"     DOUBLE PRECISION,
  "adjClose"  DOUBLE PRECISION,
  "volume"    BIGINT,
  "source"    TEXT NOT NULL DEFAULT 'yahoo',
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "PriceBar_ticker_date_key" ON "PriceBar" ("ticker", "date");
CREATE INDEX "PriceBar_ticker_date_idx" ON "PriceBar" ("ticker", "date" DESC);
