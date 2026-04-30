ALTER TABLE "issue_attachments" ADD COLUMN "usage" text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
CREATE INDEX "issue_attachments_usage_idx" ON "issue_attachments" USING btree ("usage");