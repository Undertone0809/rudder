import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase } from "../client.js";
import { createLocalPostgresInstance } from "../local-postgres-provider.js";

const migrationsDirectory = path.dirname(new URL(import.meta.url).pathname);
const migrationFilename = fs.readdirSync(migrationsDirectory)
  .find((filename) => /^0119_.*\.sql$/.test(filename));
if (!migrationFilename) {
  throw new Error("Expected generated 0119 managed MCP access migration");
}
const migrationSql = fs.readFileSync(
  path.join(migrationsDirectory, migrationFilename),
  "utf8",
);

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function migrationsThrough(maxIdx: number, targetRoot: string): string {
  const folder = path.join(targetRoot, `through-${maxIdx}`);
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(
    path.join(migrationsDirectory, "meta", "_journal.json"),
    "utf8",
  )) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(migrationsDirectory, `${entry.tag}.sql`),
      path.join(folder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(path.join(folder, "meta", "_journal.json"), JSON.stringify({
    version: journal.version,
    dialect: journal.dialect,
    entries,
  }));
  return folder;
}

describe("managed MCP canonicalization migration", () => {
  it("backfills ambiguous DDL and migration tools as destructive", () => {
    const destructiveBranch = migrationSql.match(
      /when[\s\S]*?then\s+'destructive'/i,
    )?.[0];
    expect(destructiveBranch).toMatch(/\bddl\b/i);
    expect(destructiveBranch).toMatch(/\bmigrations\b/i);
  });

  it("evaluates write capability before read for mixed-action tool names", () => {
    const writeBranch = migrationSql.indexOf("THEN 'normal_write'");
    const readBranch = migrationSql.indexOf("THEN 'read'");
    expect(writeBranch).toBeGreaterThan(-1);
    expect(readBranch).toBeGreaterThan(-1);
    expect(writeBranch).toBeLessThan(readBranch);
  });

  it("ranks official provider duplicates deterministically and retains every loser", () => {
    expect(migrationSql).toMatch(
      /row_number\(\)\s+over\s*\(\s*partition by\s+(?:"connection"\.)?"org_id",\s*(?:"connection"\.)?"provider"/i,
    );
    expect(migrationSql).toMatch(
      /case[\s\S]*(?:"connection"\.)?"status"\s*=\s*'active'[\s\S]*(?:"connection"\.)?"updated_at"\s+desc[\s\S]*(?:"connection"\.)?"id"\s+asc/i,
    );
    expect(migrationSql).toMatch(/update\s+"mcp_connections"[\s\S]*"canonical_state"\s*=\s*'superseded'/i);
    expect(migrationSql).toMatch(/"superseded_by_connection_id"\s*=/i);
    expect(migrationSql).not.toMatch(/delete\s+from\s+"mcp_connections"/i);
  });

  it("limits canonical uniqueness to official providers and leaves custom MCP multi-instance", () => {
    expect(migrationSql).toMatch(
      /create unique index\s+"mcp_connections_org_official_canonical_uq"[\s\S]*\("org_id","provider"\)[\s\S]*"provider"\s+in\s*\('supabase',\s*'linear',\s*'notion'\)[\s\S]*"canonical_state"\s*=\s*'canonical'/i,
    );
    expect(migrationSql).not.toMatch(
      /mcp_connections_org_official_canonical_uq[\s\S]*"provider"\s*=\s*'custom'/i,
    );
  });

  it("uses stable assignments so rerunning canonicalization does not choose a new winner", () => {
    expect(migrationSql).toMatch(
      /where[\s\S]{0,180}(?:"connection"\.)?"canonical_state"\s*=\s*'canonical'/i,
    );
    expect(migrationSql).toMatch(/(?:where|and)\s+(?:"ranked"\.)?"rank"\s*>\s*1/i);
    expect(migrationSql).toMatch(/where\s+"rank"\s*=\s*1/i);
  });

  it("migrates seeded duplicates without losing bindings, tools, grants, or audit history", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-mcp-canonicalization-"));
    const port = await availablePort();
    const { instance } = await createLocalPostgresInstance({
      databaseDir: path.join(tempRoot, "postgres"),
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    try {
      await instance.initialise();
      await instance.start();
      const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
      await ensurePostgresDatabase(adminUrl, "rudder");
      const databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
      const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      try {
        await migrate(drizzle(sql), {
          migrationsFolder: migrationsThrough(118, tempRoot),
        });
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES ('00000000-0000-4000-8000-000000000101', 'mcp-migration', 'MCP Migration', 'MCP');
          INSERT INTO "agents" ("id", "org_id", "name")
          VALUES (
            '00000000-0000-4000-8000-000000000102',
            '00000000-0000-4000-8000-000000000101',
            'Migration Agent'
          );
          INSERT INTO "organization_secrets" (
            "id", "org_id", "name", "purpose", "external_ref"
          ) VALUES
            (
              '00000000-0000-4000-8000-000000000301',
              '00000000-0000-4000-8000-000000000101',
              'Active grant', 'managed_mcp_oauth', 'grant-secret'
            ),
            (
              '00000000-0000-4000-8000-000000000302',
              '00000000-0000-4000-8000-000000000101',
              'Pending session', 'managed_mcp_oauth', 'session-secret'
            ),
            (
              '00000000-0000-4000-8000-000000000303',
              '00000000-0000-4000-8000-000000000101',
              'Duplicate active grant', 'managed_mcp_oauth', 'duplicate-grant-secret'
            );
          INSERT INTO "organization_secret_versions" (
            "secret_id", "version", "material", "value_sha256"
          ) VALUES
            (
              '00000000-0000-4000-8000-000000000301',
              1,
              '{"ciphertext":"grant"}'::jsonb,
              'grant-hash'
            ),
            (
              '00000000-0000-4000-8000-000000000302',
              1,
              '{"ciphertext":"session"}'::jsonb,
              'session-hash'
            ),
            (
              '00000000-0000-4000-8000-000000000303',
              1,
              '{"ciphertext":"duplicate-grant"}'::jsonb,
              'duplicate-grant-hash'
            );
          INSERT INTO "mcp_connections" (
            "id", "org_id", "name", "display_name", "provider", "transport",
            "access_mode", "status", "enabled", "updated_at"
          ) VALUES
            (
              '00000000-0000-4000-8000-000000000201',
              '00000000-0000-4000-8000-000000000101',
              'supabase-active', 'Supabase', 'supabase', 'streamable_http',
              'read_only', 'active', true, now() - interval '2 days'
            ),
            (
              '00000000-0000-4000-8000-000000000202',
              '00000000-0000-4000-8000-000000000101',
              'supabase-authorizing', 'Supabase', 'supabase', 'streamable_http',
              'read_only', 'authorizing', true, now()
            ),
            (
              '00000000-0000-4000-8000-000000000203',
              '00000000-0000-4000-8000-000000000101',
              'supabase-error', 'Supabase', 'supabase', 'streamable_http',
              'read_only', 'error', true, now() - interval '1 day'
            ),
            (
              '00000000-0000-4000-8000-000000000204',
              '00000000-0000-4000-8000-000000000101',
              'supabase-active-duplicate', 'Supabase', 'supabase', 'streamable_http',
              'read_only', 'active', true, now() - interval '3 days'
            );
          INSERT INTO "mcp_oauth_grants" (
            "org_id", "connection_id", "credential_secret_id", "status"
          ) VALUES
            (
              '00000000-0000-4000-8000-000000000101',
              '00000000-0000-4000-8000-000000000201',
              '00000000-0000-4000-8000-000000000301',
              'active'
            ),
            (
              '00000000-0000-4000-8000-000000000101',
              '00000000-0000-4000-8000-000000000204',
              '00000000-0000-4000-8000-000000000303',
              'active'
            );
          INSERT INTO "mcp_oauth_sessions" (
            "org_id", "connection_id", "state_hash", "credential_secret_id",
            "redirect_uri", "status", "expires_at"
          ) VALUES (
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000202',
            'pending-state',
            '00000000-0000-4000-8000-000000000302',
            'http://127.0.0.1/callback',
            'authorizing',
            now() + interval '10 minutes'
          );
          INSERT INTO "custom_integration_tools" (
            "id", "org_id", "connection_id", "external_tool_name", "rudder_tool_name"
          ) VALUES (
            '00000000-0000-4000-8000-000000000401',
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000202',
            'execute_sql', 'external.supabase.execute_sql'
          );
          INSERT INTO "agent_custom_integration_bindings" (
            "id", "org_id", "agent_id", "connection_id", "status", "enabled_tool_ids"
          ) VALUES (
            '00000000-0000-4000-8000-000000000501',
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000102',
            '00000000-0000-4000-8000-000000000202',
            'active',
            '["00000000-0000-4000-8000-000000000401"]'::jsonb
          );
          INSERT INTO "activity_log" (
            "org_id", "actor_id", "action", "entity_type", "entity_id"
          ) VALUES (
            '00000000-0000-4000-8000-000000000101',
            'migration-test', 'mcp.test', 'mcp_connection',
            '00000000-0000-4000-8000-000000000202'
          );
        `);
      } finally {
        await sql.end();
      }

      await expect(applyPendingMigrations(databaseUrl)).resolves.toBeUndefined();
      await expect(applyPendingMigrations(databaseUrl)).resolves.toBeUndefined();

      const verify = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      try {
        const connections = await verify.unsafe<Array<{
          id: string;
          canonical_state: string;
          superseded_by_connection_id: string | null;
          enabled: boolean;
        }>>(`
          SELECT id, canonical_state, superseded_by_connection_id, enabled
          FROM mcp_connections
          ORDER BY id
        `);
        expect(connections).toHaveLength(4);
        expect(connections[0]).toMatchObject({
          id: "00000000-0000-4000-8000-000000000201",
          canonical_state: "canonical",
          superseded_by_connection_id: null,
          enabled: true,
        });
        expect(connections.slice(1)).toEqual([
          expect.objectContaining({
            canonical_state: "superseded",
            superseded_by_connection_id: "00000000-0000-4000-8000-000000000201",
            enabled: false,
          }),
          expect.objectContaining({
            canonical_state: "superseded",
            superseded_by_connection_id: "00000000-0000-4000-8000-000000000201",
            enabled: false,
          }),
          expect.objectContaining({
            canonical_state: "superseded",
            superseded_by_connection_id: "00000000-0000-4000-8000-000000000201",
            enabled: false,
          }),
        ]);
        const [counts] = await verify.unsafe<Array<Record<string, number>>>(`
          SELECT
            (SELECT count(*)::int FROM custom_integration_tools) AS tools,
            (SELECT count(*)::int FROM agent_custom_integration_bindings) AS bindings,
            (SELECT count(*)::int FROM mcp_oauth_grants) AS grants,
            (SELECT count(*)::int FROM activity_log) AS audit,
            (SELECT count(*)::int FROM organization_secrets) AS secrets
        `);
        expect(counts).toEqual({
          tools: 1,
          bindings: 1,
          grants: 2,
          audit: 1,
          secrets: 2,
        });
        const [expiredSession] = await verify.unsafe<Array<{
          status: string;
          credential_secret_id: string | null;
        }>>(`
          SELECT status, credential_secret_id
          FROM mcp_oauth_sessions
          WHERE connection_id = '00000000-0000-4000-8000-000000000202'
        `);
        expect(expiredSession).toEqual({
          status: "expired",
          credential_secret_id: null,
        });
      } finally {
        await verify.end();
      }
    } finally {
      await instance.stop();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
