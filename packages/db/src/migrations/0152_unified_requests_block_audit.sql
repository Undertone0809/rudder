CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subtype" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"issue_id" uuid,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"origin_run_id" uuid,
	"assignee_agent_id" uuid,
	"blocker_fingerprint" text,
	"superseded_by_request_id" uuid,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"resolution" text,
	"response" text,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_block_audit_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"root_run_id" uuid NOT NULL,
	"previous_run_id" uuid,
	"agent_id" uuid NOT NULL,
	"continuation_kind" text NOT NULL,
	"eligible" boolean DEFAULT true NOT NULL,
	"failure_class" text NOT NULL,
	"blocker_fingerprint" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"required_attempts" integer NOT NULL,
	"status_before" text NOT NULL,
	"status_after" text NOT NULL,
	"reset_reason" text,
	"blocker_reason" text NOT NULL,
	"requested_action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_root_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_previous_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("previous_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_block_audit_attempts" ADD CONSTRAINT "issue_block_audit_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "requests_org_status_updated_idx" ON "requests" USING btree ("org_id","status","updated_at");
--> statement-breakpoint
CREATE INDEX "requests_issue_updated_idx" ON "requests" USING btree ("issue_id","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "requests_open_assistance_lineage_uq" ON "requests" USING btree ("org_id","issue_id","blocker_fingerprint") WHERE "kind" = 'assistance' and "status" = 'open';
--> statement-breakpoint
CREATE INDEX "issue_block_audit_attempts_issue_lineage_idx" ON "issue_block_audit_attempts" USING btree ("issue_id","blocker_fingerprint","attempt_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_block_audit_attempts_issue_run_uq" ON "issue_block_audit_attempts" USING btree ("issue_id","run_id");
