ALTER TABLE "goals" ADD COLUMN "continuation_kind" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "continuation_summary" text;--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "wake_condition" text;--> statement-breakpoint

UPDATE "goals"
SET
  "continuation_kind" = COALESCE("continuation_kind", 'verification'),
  "continuation_summary" = COALESCE(
    "continuation_summary",
    'Review the legacy Goal contract and define the next bounded verification'
  )
WHERE "status" = 'active'
  AND "lifecycle" = 'draft'
  AND "outcome_statement" IS NOT NULL
  AND jsonb_array_length("criteria") > 0
  AND "owner_agent_id" IS NOT NULL;--> statement-breakpoint
