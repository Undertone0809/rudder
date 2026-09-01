CREATE UNIQUE INDEX IF NOT EXISTS "issues_run_debug_origin_uq"
ON "issues" USING btree ("org_id", "origin_kind", "origin_id")
WHERE "origin_kind" = 'run_debug' AND "origin_id" IS NOT NULL;
