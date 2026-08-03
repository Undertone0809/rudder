ALTER TABLE "agents" ADD COLUMN "readiness_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "readiness_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "readiness_result_code" text;