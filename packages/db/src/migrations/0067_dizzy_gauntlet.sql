CREATE TABLE "agent_skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"skill_slug" text NOT NULL,
	"revision" integer NOT NULL,
	"markdown" text NOT NULL,
	"structured_spec_json" jsonb,
	"content_hash" text NOT NULL,
	"source_proposal_id" uuid,
	"created_from_feedback_batch_id" uuid,
	"created_from_reflection_id" uuid,
	"status" text DEFAULT 'approved' NOT NULL,
	"approved_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD COLUMN "agent_skill_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD COLUMN "agent_skill_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD COLUMN "agent_skill_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_created_from_feedback_batch_id_feedback_batches_id_fk" FOREIGN KEY ("created_from_feedback_batch_id") REFERENCES "public"."feedback_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_created_from_reflection_id_skill_reflections_id_fk" FOREIGN KEY ("created_from_reflection_id") REFERENCES "public"."skill_reflections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill_revisions" ADD CONSTRAINT "agent_skill_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_revisions_agent_skill_revision_idx" ON "agent_skill_revisions" USING btree ("agent_id","skill_key","revision");--> statement-breakpoint
CREATE INDEX "agent_skill_revisions_org_agent_skill_idx" ON "agent_skill_revisions" USING btree ("org_id","agent_id","skill_key");--> statement-breakpoint
CREATE INDEX "agent_skill_revisions_org_created_idx" ON "agent_skill_revisions" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD CONSTRAINT "run_loaded_skill_revisions_agent_skill_revision_id_agent_skill_revisions_id_fk" FOREIGN KEY ("agent_skill_revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_agent_skill_revision_id_agent_skill_revisions_id_fk" FOREIGN KEY ("agent_skill_revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_agent_skill_revision_id_agent_skill_revisions_id_fk" FOREIGN KEY ("agent_skill_revision_id") REFERENCES "public"."agent_skill_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_evidence_links_org_agent_revision_idx" ON "skill_evidence_links" USING btree ("org_id","agent_skill_revision_id");