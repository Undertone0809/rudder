import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDirectory = path.dirname(new URL(import.meta.url).pathname);
const migrationFilename = fs.readdirSync(migrationsDirectory)
  .find((filename) => /^0113_.*\.sql$/u.test(filename));
if (!migrationFilename) throw new Error("Expected generated 0113 organization secret purpose migration");

describe("organization secret purpose migration", () => {
  it("defaults existing and public secrets to user-managed and indexes purpose lookups", () => {
    const sql = fs.readFileSync(path.join(migrationsDirectory, migrationFilename), "utf8");

    expect(sql).toContain(
      `ADD COLUMN "purpose" text DEFAULT 'user_managed' NOT NULL`,
    );
    expect(sql).toContain(
      `CREATE INDEX "organization_secrets_org_purpose_idx"`,
    );
    expect(sql).toMatch(
      /SET "purpose" = 'managed_mcp_connection'[\s\S]*FROM "mcp_connections"/u,
    );
    expect(sql).toMatch(
      /SET "purpose" = 'managed_mcp_oauth'[\s\S]*FROM "mcp_oauth_grants"[\s\S]*FROM "mcp_oauth_sessions"/u,
    );
  });
});
