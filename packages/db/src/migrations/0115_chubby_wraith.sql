ALTER TABLE "mcp_oauth_grants" ADD COLUMN "refresh_lease_nonce" text;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD COLUMN "refresh_lease_expires_at" timestamp with time zone;