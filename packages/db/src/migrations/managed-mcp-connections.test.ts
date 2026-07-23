import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.dirname(new URL(import.meta.url).pathname);
const migrationFilename = fs.readdirSync(migrationsDirectory)
  .find((filename) => /^0111_.*\.sql$/.test(filename));
if (!migrationFilename) throw new Error("Expected generated 0111 managed MCP migration");
const migrationPath = path.join(migrationsDirectory, migrationFilename);

describe("managed MCP connection migration", () => {
  it("backfills legacy MCP definitions as disabled non-executable connections", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/INSERT INTO "mcp_connections"/);
    expect(sql).toMatch(/WHERE "kind" = 'mcp_server'/);
    expect(sql).toMatch(/'legacy_manual'/);
    expect(sql).toMatch(/false,\s*false/);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    expect(sql).toMatch(/"startup_timeout_ms" integer DEFAULT 10000 NOT NULL/);
    expect(sql).not.toContain("connect_timeout_ms");
  });

  it("links legacy tools, bindings, and audit rows to their backfilled connection", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/UPDATE "custom_integration_tools" AS "tool"[\s\S]*SET\s+"connection_id" = "tool"\."integration_id"/);
    expect(sql).toMatch(/UPDATE "agent_custom_integration_bindings" AS "binding"[\s\S]*SET "connection_id" = "binding"\."integration_id"/);
    expect(sql).toMatch(/UPDATE "custom_integration_tool_calls" AS "call"[\s\S]*SET\s+"connection_id" = "call"\."integration_id"/);
  });
});
