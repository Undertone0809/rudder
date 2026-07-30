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
  .find((filename) => /^0127_.*\.sql$/.test(filename));
if (!migrationFilename) {
  throw new Error("Expected generated 0127 project budget removal migration");
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

describe("project budget removal migration", () => {
  it("deactivates project budget policies without deleting cost history", () => {
    expect(migrationSql).toMatch(
      /update\s+"budget_policies"[\s\S]*"amount"\s*=\s*0[\s\S]*"is_active"\s*=\s*false[\s\S]*"scope_type"\s*=\s*'project'/i,
    );
    expect(migrationSql).not.toMatch(/delete\s+from\s+"budget_policies"/i);
    expect(migrationSql).not.toMatch(/(?:update|delete\s+from)\s+"cost_events"/i);
  });

  it("closes project budget incidents and their pending approvals", () => {
    expect(migrationSql).toMatch(
      /update\s+"approvals"[\s\S]*"status"\s*=\s*'rejected'[\s\S]*"budget_incidents"[\s\S]*"scope_type"\s*=\s*'project'/i,
    );
    expect(migrationSql).toMatch(
      /update\s+"budget_incidents"[\s\S]*"status"\s*=\s*'resolved'[\s\S]*"scope_type"\s*=\s*'project'[\s\S]*"status"\s*=\s*'open'/i,
    );
  });

  it("resumes projects paused by the removed budget scope", () => {
    expect(migrationSql).toMatch(
      /update\s+"projects"[\s\S]*"pause_reason"\s*=\s*null[\s\S]*"paused_at"\s*=\s*null[\s\S]*"pause_reason"\s*=\s*'budget'/i,
    );
  });

  it("migrates legacy project budget state while preserving project cost attribution", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-project-budget-removal-"));
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
          migrationsFolder: migrationsThrough(126, tempRoot),
        });
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES (
            '00000000-0000-4000-8000-000000000101',
            'project-budget-removal',
            'Project Budget Removal',
            'PBR'
          );
          INSERT INTO "agents" ("id", "org_id", "name")
          VALUES (
            '00000000-0000-4000-8000-000000000102',
            '00000000-0000-4000-8000-000000000101',
            'Cost Attribution Agent'
          );
          INSERT INTO "projects" (
            "id", "org_id", "name", "status", "pause_reason", "paused_at"
          ) VALUES (
            '00000000-0000-4000-8000-000000000103',
            '00000000-0000-4000-8000-000000000101',
            'Legacy Budget Project',
            'active',
            'budget',
            now()
          );
          INSERT INTO "approvals" (
            "id", "org_id", "type", "status", "payload"
          ) VALUES (
            '00000000-0000-4000-8000-000000000104',
            '00000000-0000-4000-8000-000000000101',
            'budget_overrun',
            'pending',
            '{}'::jsonb
          );
          INSERT INTO "budget_policies" (
            "id", "org_id", "scope_type", "scope_id", "window_kind", "amount", "is_active"
          ) VALUES (
            '00000000-0000-4000-8000-000000000105',
            '00000000-0000-4000-8000-000000000101',
            'project',
            '00000000-0000-4000-8000-000000000103',
            'lifetime',
            1000,
            true
          );
          INSERT INTO "budget_incidents" (
            "id", "org_id", "policy_id", "scope_type", "scope_id", "metric",
            "window_kind", "window_start", "window_end", "threshold_type",
            "amount_limit", "amount_observed", "status", "approval_id"
          ) VALUES (
            '00000000-0000-4000-8000-000000000106',
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000105',
            'project',
            '00000000-0000-4000-8000-000000000103',
            'billed_cents',
            'lifetime',
            now() - interval '1 day',
            now() + interval '1 day',
            'hard',
            1000,
            1200,
            'open',
            '00000000-0000-4000-8000-000000000104'
          );
          INSERT INTO "cost_events" (
            "id", "org_id", "agent_id", "project_id", "provider", "model",
            "cost_cents", "occurred_at"
          ) VALUES (
            '00000000-0000-4000-8000-000000000107',
            '00000000-0000-4000-8000-000000000101',
            '00000000-0000-4000-8000-000000000102',
            '00000000-0000-4000-8000-000000000103',
            'test',
            'test-model',
            1200,
            now()
          );
        `);
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(databaseUrl);

      const verify = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      try {
        const [state] = await verify.unsafe<Array<{
          policy_active: boolean;
          policy_amount: number;
          incident_status: string;
          approval_status: string;
          project_pause_reason: string | null;
          project_paused_at: Date | null;
          cost_event_count: number;
        }>>(`
          SELECT
            (SELECT "is_active" FROM "budget_policies"
             WHERE "id" = '00000000-0000-4000-8000-000000000105') AS policy_active,
            (SELECT "amount" FROM "budget_policies"
             WHERE "id" = '00000000-0000-4000-8000-000000000105') AS policy_amount,
            (SELECT "status" FROM "budget_incidents"
             WHERE "id" = '00000000-0000-4000-8000-000000000106') AS incident_status,
            (SELECT "status" FROM "approvals"
             WHERE "id" = '00000000-0000-4000-8000-000000000104') AS approval_status,
            (SELECT "pause_reason" FROM "projects"
             WHERE "id" = '00000000-0000-4000-8000-000000000103') AS project_pause_reason,
            (SELECT "paused_at" FROM "projects"
             WHERE "id" = '00000000-0000-4000-8000-000000000103') AS project_paused_at,
            (SELECT count(*)::int FROM "cost_events"
             WHERE "project_id" = '00000000-0000-4000-8000-000000000103') AS cost_event_count
        `);
        expect(state).toEqual({
          policy_active: false,
          policy_amount: 0,
          incident_status: "resolved",
          approval_status: "rejected",
          project_pause_reason: null,
          project_paused_at: null,
          cost_event_count: 1,
        });
      } finally {
        await verify.end();
      }
    } finally {
      await instance.stop();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
