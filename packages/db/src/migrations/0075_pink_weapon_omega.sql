CREATE INDEX "approval_comments_company_created_idx" ON "approval_comments" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_company_updated_idx" ON "approvals" USING btree ("org_id","updated_at");--> statement-breakpoint
CREATE INDEX "approvals_company_status_updated_idx" ON "approvals" USING btree ("org_id","status","updated_at");