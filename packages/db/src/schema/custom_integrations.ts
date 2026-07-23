import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { mcpConnections } from "./mcp_connections.js";
import { organizationSecrets } from "./organization_secrets.js";
import { organizations } from "./organizations.js";

export const customIntegrations = pgTable(
  "custom_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    credentialSecretId: uuid("credential_secret_id").references(() => organizationSecrets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    orgScopeIdx: index("custom_integrations_org_scope_idx").on(table.orgId, table.scope),
    orgKindIdx: index("custom_integrations_org_kind_idx").on(table.orgId, table.kind),
    ownerAgentIdx: index("custom_integrations_owner_agent_idx").on(table.ownerAgentId),
    secretIdx: index("custom_integrations_secret_idx").on(table.credentialSecretId),
    orgSlugUq: uniqueIndex("custom_integrations_org_slug_uq").on(table.orgId, table.slug),
  }),
);

export const customIntegrationTools = pgTable(
  "custom_integration_tools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => customIntegrations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => mcpConnections.id, { onDelete: "cascade" }),
    externalToolName: text("external_tool_name").notNull(),
    rudderToolName: text("rudder_tool_name").notNull(),
    description: text("description"),
    rawInputSchema: jsonb("raw_input_schema").$type<Record<string, unknown>>(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    rawOutputSchema: jsonb("raw_output_schema").$type<Record<string, unknown>>(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("active"),
    enabled: boolean("enabled").notNull().default(true),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIntegrationIdx: index("custom_integration_tools_org_integration_idx").on(table.orgId, table.integrationId),
    orgConnectionIdx: index("custom_integration_tools_org_connection_idx").on(table.orgId, table.connectionId),
    orgToolNameUq: uniqueIndex("custom_integration_tools_org_tool_name_uq").on(table.orgId, table.rudderToolName),
    ownerCheck: check(
      "custom_integration_tools_owner_check",
      sql`${table.integrationId} is not null or ${table.connectionId} is not null`,
    ),
  }),
);

export const agentCustomIntegrationBindings = pgTable(
  "agent_custom_integration_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => customIntegrations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => mcpConnections.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    enabledToolIds: jsonb("enabled_tool_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    orgAgentIdx: index("agent_custom_integration_bindings_org_agent_idx").on(table.orgId, table.agentId),
    orgIntegrationIdx: index("agent_custom_integration_bindings_org_integration_idx").on(table.orgId, table.integrationId),
    orgConnectionIdx: index("agent_custom_integration_bindings_org_connection_idx").on(table.orgId, table.connectionId),
    agentIntegrationUq: uniqueIndex("agent_custom_integration_bindings_agent_integration_uq").on(
      table.orgId,
      table.agentId,
      table.integrationId,
    ),
    agentConnectionUq: uniqueIndex("agent_custom_integration_bindings_agent_connection_uq")
      .on(table.orgId, table.agentId, table.connectionId)
      .where(sql`${table.connectionId} is not null`),
    ownerCheck: check(
      "agent_custom_integration_bindings_owner_check",
      sql`${table.integrationId} is not null or ${table.connectionId} is not null`,
    ),
  }),
);

export const customIntegrationToolCalls = pgTable(
  "custom_integration_tool_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => customIntegrations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => mcpConnections.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id").notNull().references(() => customIntegrationTools.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id"),
    conversationId: uuid("conversation_id"),
    issueId: uuid("issue_id"),
    status: text("status").notNull(),
    sanitizedInput: jsonb("sanitized_input").$type<Record<string, unknown>>().notNull().default({}),
    sanitizedResult: jsonb("sanitized_result").$type<Record<string, unknown>>(),
    redactedDispatchOutcome: jsonb("redacted_dispatch_outcome").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgAgentStartedIdx: index("custom_integration_tool_calls_org_agent_started_idx").on(table.orgId, table.agentId, table.startedAt),
    orgIntegrationStartedIdx: index("custom_integration_tool_calls_org_integration_started_idx").on(table.orgId, table.integrationId, table.startedAt),
    orgConnectionStartedIdx: index("custom_integration_tool_calls_org_connection_started_idx").on(
      table.orgId,
      table.connectionId,
      table.startedAt,
    ),
    ownerCheck: check(
      "custom_integration_tool_calls_owner_check",
      sql`${table.integrationId} is not null or ${table.connectionId} is not null`,
    ),
  }),
);
