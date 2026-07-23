CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"legacy_custom_integration_id" uuid,
	"credential_secret_id" uuid,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"provider" text NOT NULL,
	"transport" text NOT NULL,
	"external_scope" text,
	"access_mode" text DEFAULT 'provider_default' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"safe_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connect_timeout_ms" integer DEFAULT 10000 NOT NULL,
	"tool_timeout_ms" integer DEFAULT 60000 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"last_discovered_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_legacy_manual_disabled_check" CHECK ("mcp_connections"."transport" <> 'legacy_manual' or "mcp_connections"."enabled" = false),
	CONSTRAINT "mcp_connections_positive_timeouts_check" CHECK ("mcp_connections"."connect_timeout_ms" > 0 and "mcp_connections"."tool_timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"authorizing_user_id" text,
	"provider_subject" text,
	"provider_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_scope_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_secret_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"authorizing_user_id" text,
	"state_hash" text NOT NULL,
	"credential_secret_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"status" text DEFAULT 'authorizing' NOT NULL,
	"status_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '10 minutes' NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_sessions_ten_minute_lifetime_check" CHECK ("mcp_oauth_sessions"."expires_at" <= "mcp_oauth_sessions"."created_at" + interval '10 minutes'),
	CONSTRAINT "mcp_oauth_sessions_consumed_after_create_check" CHECK ("mcp_oauth_sessions"."consumed_at" is null or "mcp_oauth_sessions"."consumed_at" >= "mcp_oauth_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD COLUMN "redacted_dispatch_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "raw_input_schema" jsonb;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "raw_output_schema" jsonb;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "output_schema" jsonb;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_legacy_custom_integration_id_custom_integrations_id_fk" FOREIGN KEY ("legacy_custom_integration_id") REFERENCES "public"."custom_integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_authorizing_user_id_user_id_fk" FOREIGN KEY ("authorizing_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_grants" ADD CONSTRAINT "mcp_oauth_grants_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_authorizing_user_id_user_id_fk" FOREIGN KEY ("authorizing_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_oauth_sessions" ADD CONSTRAINT "mcp_oauth_sessions_credential_secret_id_organization_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."organization_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
INSERT INTO "mcp_connections" (
	"id",
	"org_id",
	"legacy_custom_integration_id",
	"credential_secret_id",
	"name",
	"display_name",
	"provider",
	"transport",
	"access_mode",
	"status",
	"safe_config",
	"enabled",
	"required",
	"disabled_at",
	"revoked_at",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"org_id",
	"id",
	"credential_secret_id",
	"slug",
	"display_name",
	'custom',
	'legacy_manual',
	'provider_default',
	'disabled',
	'{"legacyConfigRetained":true}'::jsonb,
	false,
	false,
	"updated_at",
	"revoked_at",
	"created_at",
	"updated_at"
FROM "custom_integrations"
WHERE "kind" = 'mcp_server'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "custom_integration_tools" AS "tool"
SET
	"connection_id" = "tool"."integration_id",
	"raw_input_schema" = "tool"."input_schema",
	"discovered_at" = COALESCE("tool"."discovered_at", "tool"."created_at")
FROM "custom_integrations" AS "integration"
WHERE
	"integration"."id" = "tool"."integration_id"
	AND "integration"."kind" = 'mcp_server';--> statement-breakpoint
UPDATE "agent_custom_integration_bindings" AS "binding"
SET "connection_id" = "binding"."integration_id"
FROM "custom_integrations" AS "integration"
WHERE
	"integration"."id" = "binding"."integration_id"
	AND "integration"."kind" = 'mcp_server';--> statement-breakpoint
UPDATE "custom_integration_tool_calls" AS "call"
SET
	"connection_id" = "call"."integration_id",
	"redacted_dispatch_outcome" = jsonb_strip_nulls(jsonb_build_object(
		'status', "call"."status",
		'errorCode', "call"."error_code"
	))
FROM "custom_integrations" AS "integration"
WHERE
	"integration"."id" = "call"."integration_id"
	AND "integration"."kind" = 'mcp_server';--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_org_name_uq" ON "mcp_connections" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_org_provider_scope_uq" ON "mcp_connections" USING btree ("org_id","provider","external_scope") WHERE "mcp_connections"."provider" <> 'custom' and "mcp_connections"."external_scope" is not null;--> statement-breakpoint
CREATE INDEX "mcp_connections_org_status_idx" ON "mcp_connections" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "mcp_connections_org_provider_idx" ON "mcp_connections" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_legacy_integration_uq" ON "mcp_connections" USING btree ("legacy_custom_integration_id") WHERE "mcp_connections"."legacy_custom_integration_id" is not null;--> statement-breakpoint
CREATE INDEX "mcp_connections_credential_secret_idx" ON "mcp_connections" USING btree ("credential_secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_grants_connection_uq" ON "mcp_oauth_grants" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_org_status_idx" ON "mcp_oauth_grants" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_authorizing_user_idx" ON "mcp_oauth_grants" USING btree ("authorizing_user_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_grants_credential_secret_idx" ON "mcp_oauth_grants" USING btree ("credential_secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_oauth_sessions_state_hash_uq" ON "mcp_oauth_sessions" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "mcp_oauth_sessions_org_connection_idx" ON "mcp_oauth_sessions" USING btree ("org_id","connection_id");--> statement-breakpoint
CREATE INDEX "mcp_oauth_sessions_expiry_idx" ON "mcp_oauth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mcp_oauth_sessions_credential_secret_idx" ON "mcp_oauth_sessions" USING btree ("credential_secret_id");--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD CONSTRAINT "custom_integration_tools_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_custom_integration_bindings_org_connection_idx" ON "agent_custom_integration_bindings" USING btree ("org_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_custom_integration_bindings_agent_connection_uq" ON "agent_custom_integration_bindings" USING btree ("org_id","agent_id","connection_id") WHERE "agent_custom_integration_bindings"."connection_id" is not null;--> statement-breakpoint
CREATE INDEX "custom_integration_tool_calls_org_connection_started_idx" ON "custom_integration_tool_calls" USING btree ("org_id","connection_id","started_at");--> statement-breakpoint
CREATE INDEX "custom_integration_tools_org_connection_idx" ON "custom_integration_tools" USING btree ("org_id","connection_id");--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_owner_check" CHECK ("agent_custom_integration_bindings"."integration_id" is not null or "agent_custom_integration_bindings"."connection_id" is not null);--> statement-breakpoint
ALTER TABLE "custom_integration_tool_calls" ADD CONSTRAINT "custom_integration_tool_calls_owner_check" CHECK ("custom_integration_tool_calls"."integration_id" is not null or "custom_integration_tool_calls"."connection_id" is not null);--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD CONSTRAINT "custom_integration_tools_owner_check" CHECK ("custom_integration_tools"."integration_id" is not null or "custom_integration_tools"."connection_id" is not null);
