CREATE TABLE "goal_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"goal_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_agent_id" uuid NOT NULL,
	"submitted_by_agent_id" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"summary" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan_payload" jsonb,
	"plan_revision_before" integer NOT NULL,
	"plan_revision_after" integer NOT NULL,
	"continuation_kind" text NOT NULL,
	"continuation_summary" text NOT NULL,
	"wake_condition" text,
	"continuation_wakeup_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_checkpoints_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade,
	CONSTRAINT "goal_checkpoints_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE cascade,
	CONSTRAINT "goal_checkpoints_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "heartbeat_runs"("id") ON DELETE restrict,
	CONSTRAINT "goal_checkpoints_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE restrict,
	CONSTRAINT "goal_checkpoints_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "agents"("id") ON DELETE restrict,
	CONSTRAINT "goal_checkpoints_continuation_wakeup_request_id_agent_wakeup_requests_id_fk" FOREIGN KEY ("continuation_wakeup_request_id") REFERENCES "agent_wakeup_requests"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX "goal_checkpoints_goal_created_idx" ON "goal_checkpoints" USING btree ("goal_id", "created_at");
--> statement-breakpoint
CREATE INDEX "goal_checkpoints_goal_run_idx" ON "goal_checkpoints" USING btree ("goal_id", "run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "goal_checkpoints_goal_idempotency_uq" ON "goal_checkpoints" USING btree ("goal_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "goal_checkpoints_continuation_wake_uq" ON "goal_checkpoints" USING btree ("continuation_wakeup_request_id") WHERE "goal_checkpoints"."continuation_wakeup_request_id" is not null;
