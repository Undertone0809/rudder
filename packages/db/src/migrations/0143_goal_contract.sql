ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "outcome_statement" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "objective_mode" text DEFAULT 'target' NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'draft' NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "contract_revision" integer DEFAULT 1 NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "criteria" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "autonomy_envelope" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "human_authorities" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "evaluation_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "action_deadline" timestamp with time zone;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "evaluation_deadline" timestamp with time zone;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "evaluation_result" jsonb;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "close_reason" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "result_payload" jsonb;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "focus" boolean DEFAULT false NOT NULL;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "plan_revision" integer DEFAULT 0 NOT NULL;

UPDATE "goals"
SET
  "lifecycle" = CASE
    -- Legacy active rows have no canonical Contract/Owner/Plan proof. They
    -- must be explicitly activated after migration instead of bypassing Draft.
    WHEN "status" = 'active' THEN 'draft'
    WHEN "status" IN ('achieved', 'cancelled') THEN 'closed'
    ELSE 'draft'
  END,
  "close_reason" = CASE
    WHEN "status" = 'achieved' THEN 'evaluated'
    WHEN "status" = 'cancelled' THEN 'cancelled'
    ELSE "close_reason"
  END;

CREATE UNIQUE INDEX IF NOT EXISTS "goals_org_focus_uq"
  ON "goals" USING btree ("org_id")
  WHERE "focus" = true;

CREATE TABLE IF NOT EXISTS "goal_owner_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "assignment_revision" integer DEFAULT 1 NOT NULL,
  "assigned_by_authority_ref" text,
  "starts_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ends_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "goal_owner_assignments_goal_idx"
  ON "goal_owner_assignments" USING btree ("goal_id", "starts_at");
CREATE UNIQUE INDEX IF NOT EXISTS "goal_owner_assignments_current_goal_uq"
  ON "goal_owner_assignments" USING btree ("goal_id")
  WHERE "ends_at" IS NULL;

CREATE TABLE IF NOT EXISTS "goal_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE cascade,
  "revision" integer NOT NULL,
  "summary" text NOT NULL,
  "hypotheses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "selected_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rejected_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sequencing" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "budget_allocations" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "invalidation_conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "goal_plans_goal_revision_uq"
  ON "goal_plans" USING btree ("goal_id", "revision");
CREATE INDEX IF NOT EXISTS "goal_plans_goal_revision_idx"
  ON "goal_plans" USING btree ("goal_id", "revision");

CREATE TABLE IF NOT EXISTS "goal_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "goal_id" uuid NOT NULL REFERENCES "goals"("id") ON DELETE cascade,
  "contract_revision" integer NOT NULL,
  "submitted_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE set null,
  "agent_owner_ref_at_time" uuid REFERENCES "agents"("id") ON DELETE set null,
  "commitment_ref" text,
  "run_ref" uuid,
  "activity_kind" text,
  "summary" text NOT NULL,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "idempotency_key" text,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "goal_activities_goal_occurred_idx"
  ON "goal_activities" USING btree ("goal_id", "occurred_at");
CREATE UNIQUE INDEX IF NOT EXISTS "goal_activities_closeout_run_uq"
  ON "goal_activities" USING btree ("goal_id", "run_ref", "activity_kind")
  WHERE "activity_kind" = 'closeout' AND "run_ref" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "goal_activities_idempotency_uq"
  ON "goal_activities" USING btree ("goal_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
