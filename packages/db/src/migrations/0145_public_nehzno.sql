CREATE TABLE "goal_change_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"expected_contract_revision" integer NOT NULL,
	"before_contract" jsonb NOT NULL,
	"after_contract" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"proposed_by_agent_id" uuid NOT NULL,
	"applied_revision" integer,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_feedback_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"body" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"feedback_kind" text DEFAULT 'ordinary' NOT NULL,
	"idempotency_key" text NOT NULL,
	"routed_wakeup_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_result_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"contract_revision" integer NOT NULL,
	"candidate" jsonb NOT NULL,
	"candidate_hash" text NOT NULL,
	"preflight" jsonb NOT NULL,
	"risk_summary" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"idempotency_key" text NOT NULL,
	"proposed_by_agent_id" uuid NOT NULL,
	"accepted_by_actor_type" text,
	"accepted_by_actor_id" text,
	"accepted_at" timestamp with time zone,
	"rejected_by_actor_type" text,
	"rejected_by_actor_id" text,
	"rejected_at" timestamp with time zone,
	"rejection_feedback" text,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_start_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"packet_hash" text NOT NULL,
	"packet" jsonb NOT NULL,
	"draft_goal_id" uuid,
	"goal_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "alignment_question" text;--> statement-breakpoint
ALTER TABLE "goal_change_proposals" ADD CONSTRAINT "goal_change_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_change_proposals" ADD CONSTRAINT "goal_change_proposals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_change_proposals" ADD CONSTRAINT "goal_change_proposals_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_change_proposals" ADD CONSTRAINT "goal_change_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_feedback_entries" ADD CONSTRAINT "goal_feedback_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_feedback_entries" ADD CONSTRAINT "goal_feedback_entries_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_feedback_entries" ADD CONSTRAINT "goal_feedback_entries_routed_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("routed_wakeup_request_id") REFERENCES "public"."agent_wakeup_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_result_proposals" ADD CONSTRAINT "goal_result_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_result_proposals" ADD CONSTRAINT "goal_result_proposals_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_result_proposals" ADD CONSTRAINT "goal_result_proposals_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_start_requests" ADD CONSTRAINT "goal_start_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_start_requests" ADD CONSTRAINT "goal_start_requests_draft_goal_id_goals_id_fk" FOREIGN KEY ("draft_goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goal_start_requests" ADD CONSTRAINT "goal_start_requests_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goal_change_proposals_goal_status_created_idx" ON "goal_change_proposals" USING btree ("goal_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_change_proposals_goal_idempotency_uq" ON "goal_change_proposals" USING btree ("goal_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_change_proposals_approval_uq" ON "goal_change_proposals" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "goal_feedback_entries_goal_created_idx" ON "goal_feedback_entries" USING btree ("goal_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_feedback_entries_goal_idempotency_uq" ON "goal_feedback_entries" USING btree ("goal_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "goal_result_proposals_goal_status_created_idx" ON "goal_result_proposals" USING btree ("goal_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_result_proposals_goal_idempotency_uq" ON "goal_result_proposals" USING btree ("goal_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "goal_start_requests_org_request_key_uq" ON "goal_start_requests" USING btree ("org_id","request_key");--> statement-breakpoint
CREATE INDEX "goal_start_requests_org_status_updated_idx" ON "goal_start_requests" USING btree ("org_id","status","updated_at");
