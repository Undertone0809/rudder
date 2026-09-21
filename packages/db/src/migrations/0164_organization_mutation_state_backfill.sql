-- Provision the private mutation ownership baseline for organizations that
-- existed before migration 0163. The owner remains Node at epoch zero; this
-- migration does not activate a Rust writer.
INSERT INTO "organization_mutation_state" ("org_id")
SELECT "id"
FROM "organizations"
ON CONFLICT ("org_id") DO NOTHING;
