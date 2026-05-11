-- Bundled trade-confirmation envelopes. One TradeRequest groups N tickers
-- (Buy lines tied to closed VotingSessions + optional Sell lines like SPY
-- to free up cash) into a single DocuSign envelope.
CREATE TABLE "TradeRequest" (
  "id"                   SERIAL PRIMARY KEY,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"            INTEGER NOT NULL,
  "note"                 TEXT,
  "tradeContext"         JSONB,
  "docusignEnvelopeId"   TEXT,
  "docusignStatus"       TEXT,
  "docusignSentAt"       TIMESTAMP(3),
  "docusignCompletedAt"  TIMESTAMP(3),
  CONSTRAINT "TradeRequest_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "TradeRequest_createdAt_idx" ON "TradeRequest"("createdAt");

CREATE TABLE "TradeRequestItem" (
  "id"              SERIAL PRIMARY KEY,
  "tradeRequestId"  INTEGER NOT NULL,
  "kind"            TEXT NOT NULL,
  "ticker"          TEXT NOT NULL,
  "shares"          INTEGER NOT NULL,
  "pricePerShare"   DOUBLE PRECISION NOT NULL,
  "totalCost"       DOUBLE PRECISION NOT NULL,
  "votingSessionId" INTEGER,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradeRequestItem_tradeRequestId_fkey"
    FOREIGN KEY ("tradeRequestId") REFERENCES "TradeRequest"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TradeRequestItem_votingSessionId_fkey"
    FOREIGN KEY ("votingSessionId") REFERENCES "VotingSession"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "TradeRequestItem_tradeRequestId_idx"
  ON "TradeRequestItem"("tradeRequestId");
CREATE INDEX "TradeRequestItem_votingSessionId_idx"
  ON "TradeRequestItem"("votingSessionId");
