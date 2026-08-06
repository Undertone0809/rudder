import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "0147_github_mcp_provider.sql"),
  "utf8",
);

describe("GitHub MCP provider migration", () => {
  it("adds GitHub to organization and agent canonical uniqueness without widening custom MCP", () => {
    expect(migrationSql).toMatch(
      /create unique index\s+"mcp_connections_org_official_canonical_uq"[\s\S]*"provider"\s+in\s*\('supabase',\s*'linear',\s*'notion',\s*'github'\)[\s\S]*"scope"\s*=\s*'organization'/i,
    );
    expect(migrationSql).toMatch(
      /create unique index\s+"mcp_connections_agent_official_canonical_uq"[\s\S]*"provider"\s+in\s*\('supabase',\s*'linear',\s*'notion',\s*'github'\)[\s\S]*"scope"\s*=\s*'agent'/i,
    );
    expect(migrationSql).not.toMatch(/provider"\s*=\s*'custom'/i);
  });
});
