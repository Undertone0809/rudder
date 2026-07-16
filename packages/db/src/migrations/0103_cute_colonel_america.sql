ALTER TABLE "heartbeat_runs" ADD COLUMN "session_params_before_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_params_after_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "session_reuse_scope" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_session_reuse_scope_check" CHECK ("heartbeat_runs"."session_reuse_scope" in ('explicit', 'task', 'none'));