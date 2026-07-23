import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";

function exportedTable(name: string): PgTable | null {
  const value = (schema as unknown as Record<string, unknown>)[name];
  expect(value, `${name} must be exported from the database schema`).toBeDefined();
  return value ? value as PgTable : null;
}

function columnNames(table: PgTable): string[] {
  return getTableConfig(table).columns.map((column) => column.name);
}

describe("managed MCP connection schema", () => {
  it("defines organization-owned connection, OAuth grant, and one-time session tables", () => {
    const connections = exportedTable("mcpConnections");
    const grants = exportedTable("mcpOAuthGrants");
    const sessions = exportedTable("mcpOAuthSessions");
    if (!connections || !grants || !sessions) return;

    expect(getTableConfig(connections).name).toBe("mcp_connections");
    expect(columnNames(connections)).toEqual(expect.arrayContaining([
      "org_id",
      "legacy_custom_integration_id",
      "credential_secret_id",
      "name",
      "display_name",
      "provider",
      "transport",
      "external_scope",
      "access_mode",
      "status",
      "safe_config",
      "connect_timeout_ms",
      "tool_timeout_ms",
      "enabled",
      "required",
      "last_discovered_at",
      "activated_at",
      "disabled_at",
      "revoked_at",
      "created_at",
      "updated_at",
    ]));

    expect(getTableConfig(grants).name).toBe("mcp_oauth_grants");
    expect(columnNames(grants)).toEqual(expect.arrayContaining([
      "org_id",
      "connection_id",
      "authorizing_user_id",
      "provider_subject",
      "provider_scopes",
      "external_scope_metadata",
      "credential_secret_id",
      "status",
      "status_metadata",
      "expires_at",
      "last_refreshed_at",
      "revoked_at",
      "created_at",
      "updated_at",
    ]));

    expect(getTableConfig(sessions).name).toBe("mcp_oauth_sessions");
    expect(columnNames(sessions)).toEqual(expect.arrayContaining([
      "org_id",
      "connection_id",
      "authorizing_user_id",
      "state_hash",
      "credential_secret_id",
      "redirect_uri",
      "status",
      "status_metadata",
      "expires_at",
      "consumed_at",
      "created_at",
    ]));
  });

  it("declares connection uniqueness and explicit lifecycle indexes", () => {
    const connections = exportedTable("mcpConnections");
    if (!connections) return;

    const config = getTableConfig(connections);
    const indexNames = config.indexes.map((index) => index.config.name);

    expect(indexNames).toEqual(expect.arrayContaining([
      "mcp_connections_org_name_uq",
      "mcp_connections_org_provider_scope_uq",
      "mcp_connections_org_status_idx",
      "mcp_connections_legacy_integration_uq",
    ]));
    expect(config.foreignKeys).toHaveLength(3);
  });

  it("extends existing tool, binding, and audit rows for discovered managed MCP tools", () => {
    expect(columnNames(schema.customIntegrationTools)).toEqual(expect.arrayContaining([
      "connection_id",
      "raw_input_schema",
      "input_schema",
      "raw_output_schema",
      "output_schema",
      "enabled",
      "discovered_at",
      "removed_at",
    ]));
    expect(columnNames(schema.agentCustomIntegrationBindings)).toContain("connection_id");
    expect(columnNames(schema.customIntegrationToolCalls)).toEqual(expect.arrayContaining([
      "connection_id",
      "redacted_dispatch_outcome",
    ]));
  });

  it("keeps legacy custom integration references nullable for backward-compatible managed rows", () => {
    const toolColumns = getTableConfig(schema.customIntegrationTools).columns;
    const bindingColumns = getTableConfig(schema.agentCustomIntegrationBindings).columns;
    const callColumns = getTableConfig(schema.customIntegrationToolCalls).columns;

    expect(toolColumns.find((column) => column.name === "integration_id")?.notNull).toBe(false);
    expect(bindingColumns.find((column) => column.name === "integration_id")?.notNull).toBe(false);
    expect(callColumns.find((column) => column.name === "integration_id")?.notNull).toBe(false);
  });
});
