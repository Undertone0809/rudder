CREATE TABLE "run_diagnostic_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"fingerprint" text NOT NULL,
	"summary" text NOT NULL,
	"details_json" jsonb,
	"evidence_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_excerpt" text,
	"source" text DEFAULT 'run_diagnostics' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "run_diagnostic_findings" ADD CONSTRAINT "run_diagnostic_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "run_diagnostic_findings" ADD CONSTRAINT "run_diagnostic_findings_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "run_diagnostic_findings" ADD CONSTRAINT "run_diagnostic_findings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "run_diagnostic_findings" ADD CONSTRAINT "run_diagnostic_findings_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
CREATE INDEX "run_diagnostic_findings_org_status_updated_idx" ON "run_diagnostic_findings" USING btree ("org_id","status","updated_at");
CREATE INDEX "run_diagnostic_findings_org_kind_idx" ON "run_diagnostic_findings" USING btree ("org_id","kind");
CREATE INDEX "run_diagnostic_findings_run_idx" ON "run_diagnostic_findings" USING btree ("run_id");
CREATE INDEX "run_diagnostic_findings_org_fingerprint_status_idx" ON "run_diagnostic_findings" USING btree ("org_id","fingerprint","status");
CREATE UNIQUE INDEX "run_diagnostic_findings_org_run_fingerprint_idx" ON "run_diagnostic_findings" USING btree ("org_id","run_id","fingerprint");
