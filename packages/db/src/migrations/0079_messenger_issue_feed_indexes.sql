CREATE INDEX "activity_log_org_entity_created_idx" ON "activity_log" USING btree ("org_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_comments_org_issue_created_id_idx" ON "issue_comments" USING btree ("org_id","issue_id","created_at","id");--> statement-breakpoint
CREATE INDEX "issue_follows_org_user_issue_idx" ON "issue_follows" USING btree ("org_id","user_id","issue_id");--> statement-breakpoint
CREATE INDEX "issues_company_created_by_user_updated_idx" ON "issues" USING btree ("org_id","created_by_user_id","updated_at","id");
