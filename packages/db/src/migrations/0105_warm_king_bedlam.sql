CREATE TABLE "entity_cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"artifact_type" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_cleanup_jobs" ADD CONSTRAINT "entity_cleanup_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_cleanup_jobs_artifact_uq" ON "entity_cleanup_jobs" USING btree ("org_id","artifact_type","artifact_ref");--> statement-breakpoint
CREATE INDEX "entity_cleanup_jobs_retry_idx" ON "entity_cleanup_jobs" USING btree ("next_attempt_at","created_at");