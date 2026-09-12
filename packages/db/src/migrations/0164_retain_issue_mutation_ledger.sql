ALTER TABLE "issue_mutation_commands"
  DROP CONSTRAINT IF EXISTS "issue_mutation_commands_org_issue_fk";
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_issue_fk"
  FOREIGN KEY ("org_id", "issue_id") REFERENCES "public"."issues"("org_id", "id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  DROP CONSTRAINT IF EXISTS "issue_mutation_commands_org_approval_fk";
--> statement-breakpoint
ALTER TABLE "issue_mutation_commands"
  ADD CONSTRAINT "issue_mutation_commands_org_approval_fk"
  FOREIGN KEY ("org_id", "approval_id") REFERENCES "public"."approvals"("org_id", "id")
  ON DELETE restrict ON UPDATE no action;
