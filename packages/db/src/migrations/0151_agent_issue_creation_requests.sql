CREATE TABLE IF NOT EXISTS "agent_issue_creation_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "requested_by_user_id" text NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "instruction" text NOT NULL,
  "project_id" uuid,
  "goal_id" uuid,
  "parent_id" uuid,
  "context_snapshot" jsonb,
  "idempotency_key" text NOT NULL,
  "wakeup_attempt" integer DEFAULT 0 NOT NULL,
  "wakeup_attempt_id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "wakeup_request_id" uuid REFERENCES "agent_wakeup_requests"("id") ON DELETE set null,
  "run_id" uuid REFERENCES "heartbeat_runs"("id") ON DELETE set null,
  "created_issue_id" uuid REFERENCES "issues"("id") ON DELETE set null,
  "status" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_issue_creation_requests_status_check"
    CHECK ("status" in ('queued', 'running', 'deferred', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_issue_creation_requests_status_updated_idx"
  ON "agent_issue_creation_requests" USING btree ("org_id", "status", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_issue_creation_requests_requester_updated_idx"
  ON "agent_issue_creation_requests" USING btree ("org_id", "requested_by_user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_issue_creation_requests_wakeup_request_idx"
  ON "agent_issue_creation_requests" USING btree ("wakeup_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_issue_creation_requests_run_idx"
  ON "agent_issue_creation_requests" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_issue_creation_requests_created_issue_idx"
  ON "agent_issue_creation_requests" USING btree ("created_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_issue_creation_requests_org_requester_idempotency_uq"
  ON "agent_issue_creation_requests" USING btree ("org_id", "requested_by_user_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_agent_issue_creation_origin_uq"
  ON "issues" USING btree ("org_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'agent_issue_creation'
    AND "origin_id" IS NOT NULL;
