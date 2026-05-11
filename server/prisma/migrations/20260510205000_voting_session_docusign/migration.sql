-- Add DocuSign trade-confirmation linkage to VotingSession.
ALTER TABLE "VotingSession"
  ADD COLUMN "docusignEnvelopeId"   TEXT,
  ADD COLUMN "docusignStatus"       TEXT,
  ADD COLUMN "docusignSentAt"       TIMESTAMP(3),
  ADD COLUMN "docusignCompletedAt"  TIMESTAMP(3),
  ADD COLUMN "docusignTradeContext" JSONB;
