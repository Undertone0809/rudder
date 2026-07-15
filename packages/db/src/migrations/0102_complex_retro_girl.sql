DROP INDEX "heartbeat_runs_active_chat_conversation_uq";--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "budget_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_exited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_owner_token" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "execution_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_completed_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_dead_lettered_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_attempts_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_dead_lettered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_claim_token" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_log_org_idempotency_key_uq" ON "activity_log" USING btree ("org_id","idempotency_key") WHERE "activity_log"."idempotency_key" is not null;--> statement-breakpoint
WITH ranked_wakeups AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "org_id", "agent_id", "idempotency_key"
    ORDER BY "created_at", "id"
  ) AS duplicate_rank
  FROM "agent_wakeup_requests"
  WHERE "idempotency_key" IS NOT NULL
)
UPDATE "agent_wakeup_requests"
SET "idempotency_key" = NULL
FROM ranked_wakeups
WHERE "agent_wakeup_requests"."id" = ranked_wakeups."id"
  AND ranked_wakeups.duplicate_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakeup_requests_company_agent_idempotency_key_uq" ON "agent_wakeup_requests" USING btree ("org_id","agent_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_company_idempotency_key_uq" ON "cost_events" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_events_run_idempotency_key_uq" ON "heartbeat_run_events" USING btree ("run_id","idempotency_key") WHERE "heartbeat_run_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "heartbeat_runs_status_execution_lease_created_idx" ON "heartbeat_runs" USING btree ("status","execution_lease_expires_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_active_chat_conversation_uq" ON "heartbeat_runs" USING btree ("org_id","chat_conversation_id") WHERE "heartbeat_runs"."chat_conversation_id" is not null and ("heartbeat_runs"."status" in ('queued', 'running') or "heartbeat_runs"."terminal_effects_pending" = true);
