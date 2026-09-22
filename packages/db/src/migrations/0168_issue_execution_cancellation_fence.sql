ALTER TABLE "issues" ADD COLUMN "execution_cancellation_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "issues"
SET "execution_cancellation_at" = COALESCE("cancelled_at", "updated_at")
WHERE "status" = 'cancelled';
