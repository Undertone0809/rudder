ALTER TABLE "cost_events" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_exited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_claim_token" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_effects_last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cost_events_company_idempotency_key_uq" ON "cost_events" USING btree ("org_id","idempotency_key");