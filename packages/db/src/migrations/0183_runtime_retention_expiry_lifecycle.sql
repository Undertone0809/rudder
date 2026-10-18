ALTER TABLE "runtime_retention_claims"
DROP CONSTRAINT "runtime_retention_claims_timestamp_order_check";
--> statement-breakpoint
ALTER TABLE "runtime_retention_claims"
ADD CONSTRAINT "runtime_retention_claims_timestamp_order_check"
CHECK (
	("status" <> 'active' OR "expires_at" IS NULL OR "expires_at" >= "created_at")
	AND ("released_at" IS NULL OR "released_at" >= "created_at")
);
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases"
DROP CONSTRAINT "runtime_source_aliases_timestamp_order_check";
--> statement-breakpoint
ALTER TABLE "runtime_source_aliases"
ADD CONSTRAINT "runtime_source_aliases_timestamp_order_check"
CHECK ("released_at" IS NULL OR "released_at" >= "created_at");
