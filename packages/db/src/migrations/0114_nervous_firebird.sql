ALTER TABLE "mcp_oauth_grants" DROP CONSTRAINT "mcp_oauth_grants_credential_secret_id_organization_secrets_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" DROP CONSTRAINT "mcp_oauth_sessions_credential_secret_id_organization_secrets_id_fk";
--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ALTER COLUMN "credential_secret_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ALTER COLUMN "credential_secret_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_active_credential_check" CHECK ("mcp_oauth_grants"."status" <> 'active' or "mcp_oauth_grants"."credential_secret_id" is not null);--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_authorizing_credential_check" CHECK ("mcp_oauth_sessions"."status" <> 'authorizing' or "mcp_oauth_sessions"."credential_secret_id" is not null);