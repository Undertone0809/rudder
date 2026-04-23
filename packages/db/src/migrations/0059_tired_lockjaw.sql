ALTER TABLE "agents" ADD COLUMN "workspace_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_org_workspace_key_idx" ON "agents" USING btree ("org_id","workspace_key");