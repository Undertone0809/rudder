-- Extend the private D1 receipt discriminator for complete Project goal-set
-- replacement. Existing receipt rows remain immutable and valid.
ALTER TABLE "organization_mutation_receipts"
  DROP CONSTRAINT "organization_mutation_receipts_kind_ck";
--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts"
  ADD CONSTRAINT "organization_mutation_receipts_kind_ck"
  CHECK ("command_kind" in ('organization_branding', 'project_goal_link', 'project_goal_set_replacement'));
