ALTER TABLE "heartbeat_runs" ADD COLUMN "running_substate" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN "network_wait_started_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN "network_wait_next_retry_at" timestamp with time zone;
ALTER TABLE "heartbeat_runs" ADD COLUMN "network_wait_attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "network_wait_duration_ms" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "heartbeat_runs" ADD COLUMN "recovery_checkpoint" jsonb;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_network_wait_recovery_idx" ON "heartbeat_runs" USING btree ("status","running_substate","network_wait_next_retry_at");
--> statement-breakpoint
CREATE TABLE "heartbeat_run_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"attempt_index" integer NOT NULL,
	"fallback_index" integer,
	"runtime_type" text NOT NULL,
	"model" text,
	"is_fallback" boolean DEFAULT false NOT NULL,
	"resume_source" text DEFAULT 'fresh' NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"submission_phase" text,
	"provider_thread_id" text,
	"provider_turn_id" text,
	"session_display_id" text,
	"session_params_json" jsonb,
	"checkpoint_json" jsonb,
	"usage_delta_json" jsonb,
	"cost_cents" integer,
	"error_code" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "heartbeat_run_attempts" ADD CONSTRAINT "heartbeat_run_attempts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_run_attempts_run_attempt_uq" ON "heartbeat_run_attempts" USING btree ("run_id","attempt_index");
CREATE INDEX "heartbeat_run_attempts_org_run_idx" ON "heartbeat_run_attempts" USING btree ("org_id","run_id","attempt_index");
CREATE INDEX "heartbeat_run_attempts_agent_created_idx" ON "heartbeat_run_attempts" USING btree ("agent_id","created_at");
--> statement-breakpoint
DROP INDEX IF EXISTS "chat_generations_active_conversation_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_generations_active_conversation_uq" ON "chat_generations" USING btree ("org_id","conversation_id") WHERE "chat_generations"."status" in ('starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping');
