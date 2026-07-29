ALTER TABLE "agent_custom_integration_bindings" ADD COLUMN "access_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD COLUMN "policy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "capability_class" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "policy_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD COLUMN "catalog_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "superseded_by_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "scope_mode" text;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "canonical_state" text DEFAULT 'canonical' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "custom_integration_tools" AS "tool"
SET "capability_class" = CASE
  WHEN "tool"."external_tool_name" ~* '(^|[._-])(delete|remove|drop|reset|merge|archive|cancel|revoke|destroy|purge|wipe|truncate|alter|ddl|migrate|migrates|migrated|migrating|migration|migrations)([._-]|$)' THEN 'destructive'
  WHEN "tool"."external_tool_name" ~* '(^|[._-])(admin|billing|invoice|key|keys|secret|secrets|member|members|permission|role|roles)([._-]|$)' THEN 'admin_or_billing'
  WHEN "tool"."external_tool_name" ~* '(^|[._-])(create|update|write|apply|deploy|send|add|move|rename|upsert|assign|comment|reply|publish)([._-]|$)' THEN 'normal_write'
  WHEN "tool"."external_tool_name" ~* '(^|[._-])(get|list|search|find|fetch|read|inspect|query|lookup|describe)([._-]|$)' THEN 'read'
  ELSE 'unknown'
END
FROM "mcp_connections" AS "connection"
WHERE "tool"."connection_id" = "connection"."id"
  AND "connection"."provider" IN ('supabase', 'linear', 'notion');--> statement-breakpoint
UPDATE "agent_custom_integration_bindings" AS "binding"
SET "access_mode" = CASE
  WHEN "connection"."provider" = 'notion' THEN 'provider_granted'
  WHEN "connection"."provider" = 'custom' THEN 'full'
  WHEN "connection"."provider" IN ('supabase', 'linear')
    AND "connection"."access_mode" = 'read_write' THEN 'read_write'
  WHEN "connection"."provider" IN ('supabase', 'linear')
    AND "connection"."access_mode" = 'read_only' THEN 'read_only'
  ELSE 'none'
END
FROM "mcp_connections" AS "connection"
WHERE "binding"."connection_id" = "connection"."id";--> statement-breakpoint
UPDATE "agent_custom_integration_bindings"
SET "access_mode" = 'full'
WHERE "connection_id" IS NULL;--> statement-breakpoint
UPDATE "mcp_connections"
SET "scope_mode" = CASE
  WHEN "provider" = 'supabase' AND "external_scope" IS NOT NULL THEN 'legacy_project'
  WHEN "provider" = 'supabase' THEN 'account'
  WHEN "provider" IN ('linear', 'notion') THEN 'workspace'
  ELSE NULL
END
WHERE "scope_mode" IS NULL;--> statement-breakpoint
WITH "ranked" AS (
  SELECT
    "connection"."id",
    "connection"."org_id",
    "connection"."provider",
    row_number() over (
      partition by "connection"."org_id", "connection"."provider"
      order by
        CASE
          WHEN "connection"."status" = 'active'
            AND "connection"."enabled" = true
            AND EXISTS (
              SELECT 1
              FROM "mcp_oauth_grants" AS "grant"
              WHERE "grant"."connection_id" = "connection"."id"
                AND "grant"."status" = 'active'
                AND "grant"."credential_secret_id" IS NOT NULL
            ) THEN 0
          WHEN "connection"."status" = 'active' AND "connection"."enabled" = true THEN 1
          WHEN "connection"."status" = 'selecting_scope' THEN 2
          WHEN "connection"."status" = 'authorizing' THEN 3
          WHEN "connection"."status" IN ('needs_reauth', 'error') THEN 4
          WHEN "connection"."status" IN ('disabled', 'revoked') THEN 5
          ELSE 6
        END,
        "connection"."updated_at" DESC,
        "connection"."id" ASC
    ) AS "rank"
  FROM "mcp_connections" AS "connection"
  WHERE "connection"."provider" IN ('supabase', 'linear', 'notion')
    AND "connection"."canonical_state" = 'canonical'
),
"winners" AS (
  SELECT "org_id", "provider", "id"
  FROM "ranked"
  WHERE "rank" = 1
)
UPDATE "mcp_connections" AS "connection"
SET
  "canonical_state" = 'superseded',
  "superseded_by_connection_id" = "winner"."id",
  "lifecycle_revision" = "connection"."lifecycle_revision" + 1,
  "enabled" = false
FROM "ranked"
JOIN "winners" AS "winner"
  ON "winner"."org_id" = "ranked"."org_id"
  AND "winner"."provider" = "ranked"."provider"
WHERE "connection"."id" = "ranked"."id"
  AND "ranked"."rank" > 1;--> statement-breakpoint
WITH "superseded_sessions" AS MATERIALIZED (
  SELECT
    "session"."id",
    "session"."credential_secret_id"
  FROM "mcp_oauth_sessions" AS "session"
  JOIN "mcp_connections" AS "connection"
    ON "connection"."id" = "session"."connection_id"
  WHERE "connection"."canonical_state" = 'superseded'
    AND "session"."status" = 'authorizing'
    AND "session"."consumed_at" IS NULL
),
"expired_sessions" AS (
  UPDATE "mcp_oauth_sessions" AS "session"
  SET
    "status" = 'expired',
    "consumed_at" = now(),
    "credential_secret_id" = NULL,
    "status_metadata" = '{"reason":"connection_superseded"}'::jsonb
  FROM "superseded_sessions"
  WHERE "session"."id" = "superseded_sessions"."id"
  RETURNING "superseded_sessions"."credential_secret_id"
)
DELETE FROM "organization_secrets"
WHERE "id" IN (
  SELECT "credential_secret_id"
  FROM "expired_sessions"
  WHERE "credential_secret_id" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_superseded_by_connection_id_mcp_connections_id_fk" FOREIGN KEY ("superseded_by_connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_org_official_canonical_uq" ON "mcp_connections" USING btree ("org_id","provider") WHERE "mcp_connections"."provider" in ('supabase', 'linear', 'notion') and "mcp_connections"."canonical_state" = 'canonical';--> statement-breakpoint
CREATE INDEX "mcp_connections_superseded_by_idx" ON "mcp_connections" USING btree ("superseded_by_connection_id");--> statement-breakpoint
ALTER TABLE "agent_custom_integration_bindings" ADD CONSTRAINT "agent_custom_integration_bindings_positive_policy_revision_check" CHECK ("agent_custom_integration_bindings"."policy_revision" > 0);--> statement-breakpoint
ALTER TABLE "custom_integration_tools" ADD CONSTRAINT "custom_integration_tools_positive_policy_revisions_check" CHECK ("custom_integration_tools"."policy_revision" > 0 and "custom_integration_tools"."catalog_revision" > 0);--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_positive_revision_check" CHECK ("mcp_connections"."revision" > 0);
