ALTER TABLE "heartbeat_runs" ADD COLUMN "goal_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX "heartbeat_runs_org_goal_created_id_idx" ON "heartbeat_runs" USING btree ("org_id","goal_id","created_at","id");
--> statement-breakpoint
UPDATE "heartbeat_runs" AS run
SET "goal_id" = goal.id
FROM "goals" AS goal
WHERE run."goal_id" IS NULL
  AND goal."org_id" = run."org_id"
  AND goal.id::text = run."context_snapshot" ->> 'goalId';
