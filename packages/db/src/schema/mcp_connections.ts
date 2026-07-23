import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { customIntegrations } from "./custom_integrations.js";
import { organizationSecrets } from "./organization_secrets.js";
import { organizations } from "./organizations.js";

export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    legacyCustomIntegrationId: uuid("legacy_custom_integration_id")
      .references(() => customIntegrations.id, { onDelete: "set null" }),
    credentialSecretId: uuid("credential_secret_id")
      .references(() => organizationSecrets.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    provider: text("provider").notNull(),
    transport: text("transport").notNull(),
    externalScope: text("external_scope"),
    accessMode: text("access_mode").notNull().default("provider_default"),
    status: text("status").notNull().default("draft"),
    safeConfig: jsonb("safe_config").$type<Record<string, unknown>>().notNull().default({}),
    connectTimeoutMs: integer("connect_timeout_ms").notNull().default(10_000),
    toolTimeoutMs: integer("tool_timeout_ms").notNull().default(60_000),
    enabled: boolean("enabled").notNull().default(true),
    required: boolean("required").notNull().default(false),
    lastDiscoveredAt: timestamp("last_discovered_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameUq: uniqueIndex("mcp_connections_org_name_uq").on(table.orgId, table.name),
    orgProviderScopeUq: uniqueIndex("mcp_connections_org_provider_scope_uq")
      .on(table.orgId, table.provider, table.externalScope)
      .where(sql`${table.provider} <> 'custom' and ${table.externalScope} is not null`),
    orgStatusIdx: index("mcp_connections_org_status_idx").on(table.orgId, table.status),
    orgProviderIdx: index("mcp_connections_org_provider_idx").on(table.orgId, table.provider),
    legacyIntegrationUq: uniqueIndex("mcp_connections_legacy_integration_uq")
      .on(table.legacyCustomIntegrationId)
      .where(sql`${table.legacyCustomIntegrationId} is not null`),
    credentialSecretIdx: index("mcp_connections_credential_secret_idx").on(table.credentialSecretId),
    legacyManualDisabledCheck: check(
      "mcp_connections_legacy_manual_disabled_check",
      sql`${table.transport} <> 'legacy_manual' or ${table.enabled} = false`,
    ),
    positiveTimeoutsCheck: check(
      "mcp_connections_positive_timeouts_check",
      sql`${table.connectTimeoutMs} > 0 and ${table.toolTimeoutMs} > 0`,
    ),
  }),
);

export const mcpOAuthGrants = pgTable(
  "mcp_oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "cascade" }),
    authorizingUserId: text("authorizing_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    providerSubject: text("provider_subject"),
    providerScopes: jsonb("provider_scopes").$type<string[]>().notNull().default([]),
    externalScopeMetadata: jsonb("external_scope_metadata").$type<Record<string, unknown>>().notNull().default({}),
    credentialSecretId: uuid("credential_secret_id").notNull()
      .references(() => organizationSecrets.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    statusMetadata: jsonb("status_metadata").$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectionUq: uniqueIndex("mcp_oauth_grants_connection_uq").on(table.connectionId),
    orgStatusIdx: index("mcp_oauth_grants_org_status_idx").on(table.orgId, table.status),
    authorizingUserIdx: index("mcp_oauth_grants_authorizing_user_idx").on(table.authorizingUserId),
    credentialSecretIdx: index("mcp_oauth_grants_credential_secret_idx").on(table.credentialSecretId),
  }),
);

export const mcpOAuthSessions = pgTable(
  "mcp_oauth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => mcpConnections.id, { onDelete: "cascade" }),
    authorizingUserId: text("authorizing_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    stateHash: text("state_hash").notNull(),
    credentialSecretId: uuid("credential_secret_id").notNull()
      .references(() => organizationSecrets.id, { onDelete: "restrict" }),
    redirectUri: text("redirect_uri").notNull(),
    status: text("status").notNull().default("authorizing"),
    statusMetadata: jsonb("status_metadata").$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
      .default(sql`now() + interval '10 minutes'`),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateHashUq: uniqueIndex("mcp_oauth_sessions_state_hash_uq").on(table.stateHash),
    orgConnectionIdx: index("mcp_oauth_sessions_org_connection_idx").on(table.orgId, table.connectionId),
    expiryIdx: index("mcp_oauth_sessions_expiry_idx").on(table.expiresAt),
    credentialSecretIdx: index("mcp_oauth_sessions_credential_secret_idx").on(table.credentialSecretId),
    tenMinuteLifetimeCheck: check(
      "mcp_oauth_sessions_ten_minute_lifetime_check",
      sql`${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`,
    ),
    consumedAfterCreateCheck: check(
      "mcp_oauth_sessions_consumed_after_create_check",
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
  }),
);
