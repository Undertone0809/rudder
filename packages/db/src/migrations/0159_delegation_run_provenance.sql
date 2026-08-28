ALTER TABLE "heartbeat_runs" ADD COLUMN "source_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_company_source_run_idx" ON "heartbeat_runs" USING btree ("org_id", "source_run_id");
