ALTER TABLE "organization_secrets" ADD COLUMN "purpose" text DEFAULT 'user_managed' NOT NULL;--> statement-breakpoint
UPDATE "organization_secrets"
SET "purpose" = 'managed_mcp_connection'
WHERE "id" IN (
  SELECT "credential_secret_id"
  FROM "mcp_connections"
  WHERE "credential_secret_id" IS NOT NULL
);--> statement-breakpoint
UPDATE "organization_secrets"
SET "purpose" = 'managed_mcp_oauth'
WHERE "id" IN (
  SELECT "credential_secret_id" FROM "mcp_oauth_grants"
  UNION
  SELECT "credential_secret_id" FROM "mcp_oauth_sessions"
);--> statement-breakpoint
CREATE INDEX "organization_secrets_org_purpose_idx" ON "organization_secrets" USING btree ("org_id","purpose");
