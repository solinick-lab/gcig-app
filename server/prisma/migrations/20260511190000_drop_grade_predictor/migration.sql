-- Sandbox grade predictor is removed from the app. Drop the two tables
-- that backed it (training corpus + per-prediction analysis log) so
-- the schema doesn't drift. Both had nullable createdById with
-- ON DELETE SET NULL, so no FK cleanup on User is required.
DROP TABLE IF EXISTS "GradePredictorAnalysis";
DROP TABLE IF EXISTS "GradePredictorExample";
