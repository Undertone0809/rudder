import fs from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0111_charming_shinko_yamashiro.sql", import.meta.url);

describe("managed MCP connection migration", () => {
  it("backfills legacy MCP definitions as disabled non-executable connections", () => {
    const sql = fs.readFileSync(migrationUrl, "utf8");

    expect(sql).toMatch(/INSERT INTO "mcp_connections"/);
    expect(sql).toMatch(/WHERE "kind" = 'mcp_server'/);
    expect(sql).toMatch(/'legacy_manual'/);
    expect(sql).toMatch(/false,\s*false/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it("links legacy tools, bindings, and audit rows to their backfilled connection", () => {
    const sql = fs.readFileSync(migrationUrl, "utf8");

    expect(sql).toMatch(/UPDATE "custom_integration_tools" AS "tool"[\s\S]*SET\s+"connection_id" = "tool"\."integration_id"/);
    expect(sql).toMatch(/UPDATE "agent_custom_integration_bindings" AS "binding"[\s\S]*SET "connection_id" = "binding"\."integration_id"/);
    expect(sql).toMatch(/UPDATE "custom_integration_tool_calls" AS "call"[\s\S]*SET\s+"connection_id" = "call"\."integration_id"/);
  });
});
