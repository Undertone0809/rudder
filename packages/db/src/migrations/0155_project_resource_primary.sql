ALTER TABLE "project_resource_attachments" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_resource_attachments_project_primary_idx" ON "project_resource_attachments" USING btree ("project_id") WHERE "project_resource_attachments"."is_primary" = true;
