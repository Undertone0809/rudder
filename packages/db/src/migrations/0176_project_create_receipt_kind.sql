-- Extend immutable organization receipts for the Project-create service pilot.
ALTER TABLE "organization_mutation_receipts"
  DROP CONSTRAINT "organization_mutation_receipts_kind_ck";
--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts"
  ADD CONSTRAINT "organization_mutation_receipts_kind_ck"
  CHECK ("command_kind" in ('organization_branding', 'project_goal_link', 'project_goal_set_replacement', 'project_delete', 'project_create'));
