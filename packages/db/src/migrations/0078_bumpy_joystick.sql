DROP INDEX "issues_open_automation_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_automation_execution_uq" ON "issues" USING btree ("org_id","origin_kind","origin_id","origin_run_id") WHERE "issues"."origin_kind" = 'automation_execution'
          and "issues"."origin_id" is not null
          and "issues"."origin_run_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');