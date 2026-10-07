ALTER TABLE "organization_mutation_receipts" ALTER COLUMN "activity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_mutation_receipts" ADD CONSTRAINT "organization_mutation_receipts_activity_mode_ck" CHECK (("organization_mutation_receipts"."activity_id" is null) = coalesce(
        "organization_mutation_receipts"."command_kind" = 'project_goal_set_replacement'
        and "organization_mutation_receipts"."result"->'result'->>'kind' = 'project_patch'
        and "organization_mutation_receipts"."result"->'result'->>'mutation_origin' = 'organization_import',
        false));