ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "fencing_token" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "checkout_lease_owner" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "checkout_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_org_id_id_uq"
  ON "issues" USING btree ("org_id", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_org_checkout_lease_idx"
  ON "issues" USING btree ("org_id", "checkout_lease_expires_at", "checkout_run_id");
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decision" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decision_idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_org_id_id_uq"
  ON "approvals" USING btree ("org_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_org_decision_idempotency_uq"
  ON "approvals" USING btree ("org_id", "decision_idempotency_key")
  WHERE "decision_idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_log_org_id_id_uq"
  ON "activity_log" USING btree ("org_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_mutation_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "issue_id" uuid,
  "approval_id" uuid,
  "command_type" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_fingerprint" text NOT NULL,
  "outcome" jsonb NOT NULL,
  "activity_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_issue_fk"
  FOREIGN KEY ("org_id", "issue_id") REFERENCES "public"."issues"("org_id", "id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_approval_fk"
  FOREIGN KEY ("org_id", "approval_id") REFERENCES "public"."approvals"("org_id", "id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_activity_fk"
  FOREIGN KEY ("org_id", "activity_id") REFERENCES "public"."activity_log"("org_id", "id")
  ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_mutation_commands_org_idempotency_uq"
  ON "issue_mutation_commands" USING btree ("org_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_mutation_commands_org_created_idx"
  ON "issue_mutation_commands" USING btree ("org_id", "issue_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_mutation_commands_approval_created_idx"
  ON "issue_mutation_commands" USING btree ("org_id", "approval_id", "created_at");
