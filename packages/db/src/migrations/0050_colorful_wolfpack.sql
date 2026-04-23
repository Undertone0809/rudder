ALTER TABLE "routine_runs" RENAME TO "automation_runs";--> statement-breakpoint
ALTER TABLE "routine_triggers" RENAME TO "automation_triggers";--> statement-breakpoint
ALTER TABLE "routines" RENAME TO "automations";--> statement-breakpoint
ALTER TABLE "automation_runs" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "automation_triggers" RENAME COLUMN "routine_id" TO "automation_id";--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "routine_runs_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "routine_runs_routine_id_routines_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "routine_runs_trigger_id_routine_triggers_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT IF EXISTS "routine_runs_linked_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "routine_triggers_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "routine_triggers_routine_id_routines_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "routine_triggers_secret_id_organization_secrets_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "routine_triggers_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_triggers" DROP CONSTRAINT IF EXISTS "routine_triggers_updated_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_org_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_goal_id_goals_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_parent_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_assignee_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "automations" DROP CONSTRAINT IF EXISTS "routines_updated_by_agent_id_agents_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_runs_company_routine_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_runs_trigger_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_runs_linked_issue_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_runs_trigger_idempotency_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_triggers_company_routine_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_triggers_company_kind_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_triggers_next_run_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_triggers_public_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routine_triggers_public_id_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "routines_company_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routines_company_assignee_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "routines_company_project_idx";--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_secret_id_organization_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_triggers" ADD CONSTRAINT "automation_triggers_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "public"."goals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_parent_issue_id_issues_id_fk" FOREIGN KEY ("parent_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_automation_execution_uq" ON "issues" USING btree ("org_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'automation_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
CREATE INDEX "automation_runs_company_automation_idx" ON "automation_runs" USING btree ("org_id","automation_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_trigger_idx" ON "automation_runs" USING btree ("trigger_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_runs_linked_issue_idx" ON "automation_runs" USING btree ("linked_issue_id");--> statement-breakpoint
CREATE INDEX "automation_runs_trigger_idempotency_idx" ON "automation_runs" USING btree ("trigger_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "automation_triggers_company_automation_idx" ON "automation_triggers" USING btree ("org_id","automation_id");--> statement-breakpoint
CREATE INDEX "automation_triggers_company_kind_idx" ON "automation_triggers" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "automation_triggers_next_run_idx" ON "automation_triggers" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "automation_triggers_public_id_idx" ON "automation_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_triggers_public_id_uq" ON "automation_triggers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "automations_company_status_idx" ON "automations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "automations_company_assignee_idx" ON "automations" USING btree ("org_id","assignee_agent_id");--> statement-breakpoint
CREATE INDEX "automations_company_project_idx" ON "automations" USING btree ("org_id","project_id");
