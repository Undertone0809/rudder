UPDATE "approvals"
SET
  "status" = 'rejected',
  "decision_note" = COALESCE("decision_note", 'Project budgets were removed'),
  "decided_at" = COALESCE("decided_at", now()),
  "updated_at" = now()
WHERE
  "status" = 'pending'
  AND "id" IN (
    SELECT "approval_id"
    FROM "budget_incidents"
    WHERE "scope_type" = 'project' AND "approval_id" IS NOT NULL
  );
--> statement-breakpoint
UPDATE "budget_incidents"
SET
  "status" = 'resolved',
  "resolved_at" = COALESCE("resolved_at", now()),
  "updated_at" = now()
WHERE "scope_type" = 'project' AND "status" = 'open';
--> statement-breakpoint
UPDATE "budget_policies"
SET
  "amount" = 0,
  "is_active" = false,
  "updated_at" = now()
WHERE "scope_type" = 'project' AND "is_active" = true;
--> statement-breakpoint
UPDATE "projects"
SET
  "pause_reason" = NULL,
  "paused_at" = NULL,
  "updated_at" = now()
WHERE "pause_reason" = 'budget';
