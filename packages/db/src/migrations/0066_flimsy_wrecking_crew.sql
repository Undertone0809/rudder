CREATE TABLE "feedback_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"submitted_by_user_id" text,
	"submitted_by_agent_id" uuid,
	"target_agent_id" uuid NOT NULL,
	"target_skill_id" uuid,
	"summary" text,
	"status" text DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"feedback_batch_id" uuid,
	"reflection_id" uuid,
	"target_agent_id" uuid NOT NULL,
	"target_skill_id" uuid,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"applies_when_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"must_not" text,
	"target_skill_reason" text,
	"classification" text DEFAULT 'core_behavior' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"validation_checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
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
CREATE TABLE "run_feedback_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"source_kind" text NOT NULL,
	"source_id" text,
	"event_id" text,
	"event_seq" integer,
	"log_ref" text,
	"log_byte_start" bigint,
	"log_byte_end" bigint,
	"transcript_entry_key" text,
	"selected_text_snapshot" text,
	"content_hash" text,
	"body" text NOT NULL,
	"feedback_type" text DEFAULT 'behavior' NOT NULL,
	"severity" text DEFAULT 'medium' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_feedback_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"target_agent_id" uuid NOT NULL,
	"target_skill_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_loaded_skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_key" text NOT NULL,
	"skill_revision_id" uuid,
	"content_hash" text,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_evaluation_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid,
	"skill_revision_id" uuid,
	"score" real,
	"applicable_checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"passed_items_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"missed_items_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"skill_update_proposal_id" uuid,
	"skill_revision_id" uuid,
	"feedback_item_id" uuid,
	"run_id" uuid,
	"issue_id" uuid,
	"event_id" text,
	"event_seq" integer,
	"evidence_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_reflections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"time_range_start" timestamp with time zone,
	"time_range_end" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_update_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_skill_id" uuid,
	"target_skill_key" text,
	"target_agent_id" uuid NOT NULL,
	"base_revision_id" uuid,
	"base_content_hash" text,
	"title" text NOT NULL,
	"summary" text,
	"patch_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"markdown_diff" text,
	"structured_spec_diff_json" jsonb,
	"rationale" text,
	"expected_behavior" text,
	"validation_checks_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approved_by_user_id" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"approval_id" uuid,
	"rollback_plan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_batches" ADD CONSTRAINT "feedback_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_batches" ADD CONSTRAINT "feedback_batches_session_id_run_feedback_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."run_feedback_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_batches" ADD CONSTRAINT "feedback_batches_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_batches" ADD CONSTRAINT "feedback_batches_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_batches" ADD CONSTRAINT "feedback_batches_target_skill_id_organization_skills_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_feedback_batch_id_feedback_batches_id_fk" FOREIGN KEY ("feedback_batch_id") REFERENCES "public"."feedback_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_reflection_id_skill_reflections_id_fk" FOREIGN KEY ("reflection_id") REFERENCES "public"."skill_reflections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_candidates" ADD CONSTRAINT "learning_candidates_target_skill_id_organization_skills_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_skill_revisions" ADD CONSTRAINT "organization_skill_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_skill_revisions" ADD CONSTRAINT "organization_skill_revisions_skill_id_organization_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_skill_revisions" ADD CONSTRAINT "organization_skill_revisions_created_from_feedback_batch_id_feedback_batches_id_fk" FOREIGN KEY ("created_from_feedback_batch_id") REFERENCES "public"."feedback_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_skill_revisions" ADD CONSTRAINT "organization_skill_revisions_created_from_reflection_id_skill_reflections_id_fk" FOREIGN KEY ("created_from_reflection_id") REFERENCES "public"."skill_reflections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_skill_revisions" ADD CONSTRAINT "organization_skill_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_items" ADD CONSTRAINT "run_feedback_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_items" ADD CONSTRAINT "run_feedback_items_session_id_run_feedback_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."run_feedback_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_items" ADD CONSTRAINT "run_feedback_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_items" ADD CONSTRAINT "run_feedback_items_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_items" ADD CONSTRAINT "run_feedback_items_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_sessions" ADD CONSTRAINT "run_feedback_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_sessions" ADD CONSTRAINT "run_feedback_sessions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_sessions" ADD CONSTRAINT "run_feedback_sessions_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback_sessions" ADD CONSTRAINT "run_feedback_sessions_target_skill_id_organization_skills_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD CONSTRAINT "run_loaded_skill_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD CONSTRAINT "run_loaded_skill_revisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD CONSTRAINT "run_loaded_skill_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_loaded_skill_revisions" ADD CONSTRAINT "run_loaded_skill_revisions_skill_revision_id_organization_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."organization_skill_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_skill_id_organization_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evaluation_reports" ADD CONSTRAINT "skill_evaluation_reports_skill_revision_id_organization_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."organization_skill_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_skill_update_proposal_id_skill_update_proposals_id_fk" FOREIGN KEY ("skill_update_proposal_id") REFERENCES "public"."skill_update_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_skill_revision_id_organization_skill_revisions_id_fk" FOREIGN KEY ("skill_revision_id") REFERENCES "public"."organization_skill_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_feedback_item_id_run_feedback_items_id_fk" FOREIGN KEY ("feedback_item_id") REFERENCES "public"."run_feedback_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_evidence_links" ADD CONSTRAINT "skill_evidence_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reflections" ADD CONSTRAINT "skill_reflections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_reflections" ADD CONSTRAINT "skill_reflections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_update_proposals" ADD CONSTRAINT "skill_update_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_update_proposals" ADD CONSTRAINT "skill_update_proposals_target_skill_id_organization_skills_id_fk" FOREIGN KEY ("target_skill_id") REFERENCES "public"."organization_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_update_proposals" ADD CONSTRAINT "skill_update_proposals_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_update_proposals" ADD CONSTRAINT "skill_update_proposals_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_batches_org_target_agent_idx" ON "feedback_batches" USING btree ("org_id","target_agent_id");--> statement-breakpoint
CREATE INDEX "feedback_batches_session_idx" ON "feedback_batches" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "feedback_batches_org_status_idx" ON "feedback_batches" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "learning_candidates_org_batch_idx" ON "learning_candidates" USING btree ("org_id","feedback_batch_id");--> statement-breakpoint
CREATE INDEX "learning_candidates_org_agent_status_idx" ON "learning_candidates" USING btree ("org_id","target_agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_skill_revisions_skill_revision_idx" ON "organization_skill_revisions" USING btree ("skill_id","revision");--> statement-breakpoint
CREATE INDEX "organization_skill_revisions_org_skill_idx" ON "organization_skill_revisions" USING btree ("org_id","skill_id");--> statement-breakpoint
CREATE INDEX "organization_skill_revisions_org_created_idx" ON "organization_skill_revisions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "run_feedback_items_org_run_idx" ON "run_feedback_items" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "run_feedback_items_session_idx" ON "run_feedback_items" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "run_feedback_items_agent_idx" ON "run_feedback_items" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "run_feedback_sessions_org_target_agent_idx" ON "run_feedback_sessions" USING btree ("org_id","target_agent_id");--> statement-breakpoint
CREATE INDEX "run_feedback_sessions_org_status_idx" ON "run_feedback_sessions" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "run_loaded_skill_revisions_run_skill_idx" ON "run_loaded_skill_revisions" USING btree ("run_id","skill_key");--> statement-breakpoint
CREATE INDEX "run_loaded_skill_revisions_org_run_idx" ON "run_loaded_skill_revisions" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "run_loaded_skill_revisions_org_agent_idx" ON "run_loaded_skill_revisions" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "skill_evaluation_reports_org_run_idx" ON "skill_evaluation_reports" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "skill_evaluation_reports_org_agent_idx" ON "skill_evaluation_reports" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "skill_evidence_links_org_proposal_idx" ON "skill_evidence_links" USING btree ("org_id","skill_update_proposal_id");--> statement-breakpoint
CREATE INDEX "skill_evidence_links_org_revision_idx" ON "skill_evidence_links" USING btree ("org_id","skill_revision_id");--> statement-breakpoint
CREATE INDEX "skill_evidence_links_org_run_idx" ON "skill_evidence_links" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "skill_reflections_org_agent_idx" ON "skill_reflections" USING btree ("org_id","agent_id");--> statement-breakpoint
CREATE INDEX "skill_reflections_org_status_idx" ON "skill_reflections" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "skill_update_proposals_org_agent_status_idx" ON "skill_update_proposals" USING btree ("org_id","target_agent_id","status");--> statement-breakpoint
CREATE INDEX "skill_update_proposals_org_skill_idx" ON "skill_update_proposals" USING btree ("org_id","target_skill_id");