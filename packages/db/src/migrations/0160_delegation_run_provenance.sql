ALTER TABLE "heartbeat_runs" ADD COLUMN "source_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN "delegation_idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_source_run_idx" ON "heartbeat_runs" USING btree ("org_id", "source_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wakeup_requests_company_delegation_idempotency_key_uq" ON "agent_wakeup_requests" USING btree ("org_id", "delegation_idempotency_key") WHERE "agent_wakeup_requests"."delegation_idempotency_key" is not null;
