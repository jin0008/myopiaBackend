-- Add the "A-scan" biometer to the instrument lookup table.
-- Idempotent: ON CONFLICT keeps re-runs / partially-seeded DBs safe.
INSERT INTO "instrument" ("name")
VALUES ('A-scan')
ON CONFLICT (name) DO NOTHING;
