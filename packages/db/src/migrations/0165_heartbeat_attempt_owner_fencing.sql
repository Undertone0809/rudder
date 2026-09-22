ALTER TABLE "heartbeat_run_attempts" ADD COLUMN "owner_token" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD COLUMN "attempt_epoch" integer;
--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_owner_fence_shape_check"
	CHECK (
		("owner_token" IS NULL AND "attempt_epoch" IS NULL)
		OR
		("owner_token" IS NOT NULL AND btrim("owner_token") <> '' AND "attempt_epoch" IS NOT NULL AND "attempt_epoch" > 0)
	);
