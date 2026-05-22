ALTER TABLE "organization_resources" ADD COLUMN "source_type" text DEFAULT 'external' NOT NULL;--> statement-breakpoint
CREATE INDEX "organization_resources_org_source_type_idx" ON "organization_resources" USING btree ("org_id","source_type");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_resources_org_library_locator_uq" ON "organization_resources" USING btree ("org_id","locator") WHERE "organization_resources"."source_type" = 'library';
