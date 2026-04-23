import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  ensurePostgresDatabase,
  ensurePostgresRolePassword,
  inspectMigrations,
  reconcilePendingMigrationHistory,
} from "./client.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

const tempPaths: string[] = [];
const runningInstances: EmbeddedPostgresInstance[] = [];

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function createTempDatabase(): Promise<string> {
  return createTempDatabaseWithPassword("rudder");
}

async function createTempDatabaseWithPassword(password: string): Promise<string> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-db-client-"));
  tempPaths.push(dataDir);
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password,
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  runningInstances.push(instance);

  const adminUrl = `postgres://rudder:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  return `postgres://rudder:${encodeURIComponent(password)}@127.0.0.1:${port}/rudder`;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (runningInstances.length > 0) {
    const instance = runningInstances.pop();
    if (!instance) continue;
    await instance.stop();
  }
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (!tempPath) continue;
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

describe("applyPendingMigrations", () => {
  it(
    "normalizes legacy embedded cluster passwords back to rudder",
    async () => {
      const legacyConnectionString = await createTempDatabaseWithPassword("password");
      const legacyUrl = new URL(legacyConnectionString);
      const legacyDataDir = tempPaths[tempPaths.length - 1];
      expect(legacyDataDir).toBeTruthy();

      const result = await ensurePostgresRolePassword({
        host: legacyUrl.hostname,
        port: Number(legacyUrl.port),
        user: "rudder",
        database: "postgres",
        preferredPassword: "rudder",
        fallbackPasswords: ["password"],
        expectedDataDir: legacyDataDir,
      });

      expect(result.normalized).toBe(true);
      expect(result.password).toBe("rudder");

      const sql = postgres(result.connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await sql<{ current_user: string }[]>`select current_user`;
        expect(rows[0]?.current_user).toBe("rudder");
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "rebuilds schema when migration journal exists but core tables are missing",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
        await sql.unsafe('CREATE SCHEMA "public"');
      } finally {
        await sql.end();
      }

      const brokenState = await inspectMigrations(connectionString);
      expect(brokenState).toMatchObject({
        status: "needsMigrations",
        reason: "missing-core-schema",
      });

      await applyPendingMigrations(connectionString);

      const repairedState = await inspectMigrations(connectionString);
      expect(repairedState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'organizations'
          `,
        );
        expect(rows).toHaveLength(1);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "applies the organization schema on a fresh database",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('organization_logos', 'execution_workspaces')
            ORDER BY table_name
          `,
        );
        expect(rows.map((row) => row.table_name)).toEqual([
          "execution_workspaces",
          "organization_logos",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0044 safely when its schema changes already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const illegalToadHash = await migrationHash("0044_illegal_toad.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${illegalToadHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'instance_settings'
              AND column_name = 'general'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0044_illegal_toad.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "repairs missing migration history when the schema changes are still directly verifiable",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const missingHashes = await Promise.all([
          migrationHash("0021_chief_vindicator.sql"),
          migrationHash("0031_zippy_magma.sql"),
          migrationHash("0044_illegal_toad.sql"),
        ]);

        for (const hash of missingHashes) {
          await sql.unsafe(
            `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${hash}'`,
          );
        }
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        reason: "pending-migrations",
      });
      if (pendingState.status !== "needsMigrations") {
        throw new Error(`Expected pending migrations, got ${pendingState.status}`);
      }
      expect(pendingState.pendingMigrations).toEqual([
        "0021_chief_vindicator.sql",
        "0031_zippy_magma.sql",
        "0044_illegal_toad.sql",
      ]);

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "normalizes legacy adapter column names before using an up-to-date migration journal",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`ALTER TABLE "agents" RENAME COLUMN "agent_runtime_type" TO "adapter_type"`);
        await sql.unsafe(`ALTER TABLE "agents" RENAME COLUMN "agent_runtime_config" TO "adapter_config"`);
        await sql.unsafe(`ALTER TABLE "agent_runtime_state" RENAME COLUMN "agent_runtime_type" TO "adapter_type"`);
        await sql.unsafe(`ALTER TABLE "agent_task_sessions" RENAME COLUMN "agent_runtime_type" TO "adapter_type"`);
        await sql.unsafe(`ALTER TABLE "join_requests" RENAME COLUMN "agent_runtime_type" TO "adapter_type"`);
        await sql.unsafe(
          `ALTER TABLE "finance_events" RENAME COLUMN "execution_agent_runtime_type" TO "execution_adapter_type"`,
        );
        await sql.unsafe(
          `ALTER TABLE "issues" RENAME COLUMN "assignee_agent_runtime_overrides" TO "assignee_adapter_overrides"`,
        );
      } finally {
        await sql.end();
      }

      const driftedState = await inspectMigrations(connectionString);
      expect(driftedState.status).toBe("upToDate");

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const oldColumns = await verifySql.unsafe<{ table_name: string; column_name: string }[]>(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name IN ('agent_runtime_state', 'agent_task_sessions', 'join_requests') AND column_name = 'adapter_type')
                OR (table_name = 'agents' AND column_name IN ('adapter_type', 'adapter_config'))
                OR (table_name = 'finance_events' AND column_name = 'execution_adapter_type')
                OR (table_name = 'issues' AND column_name = 'assignee_adapter_overrides')
              )
          `,
        );
        expect(oldColumns).toHaveLength(0);

        const newColumns = await verifySql.unsafe<{ table_name: string; column_name: string }[]>(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name IN ('agent_runtime_state', 'agent_task_sessions', 'join_requests', 'agents') AND column_name = 'agent_runtime_type')
                OR (table_name = 'agents' AND column_name = 'agent_runtime_config')
                OR (table_name = 'finance_events' AND column_name = 'execution_agent_runtime_type')
                OR (table_name = 'issues' AND column_name = 'assignee_agent_runtime_overrides')
              )
            ORDER BY table_name, column_name
          `,
        );
        expect(newColumns).toHaveLength(7);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "keeps a missing migration pending until the schema change really exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const chiefVindicatorHash = await migrationHash("0021_chief_vindicator.sql");
        await sql.unsafe(
          `ALTER TABLE "issues" RENAME COLUMN "assignee_agent_runtime_overrides" TO "assignee_adapter_overrides"`,
        );
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${chiefVindicatorHash}'`,
        );
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        reason: "pending-migrations",
      });
      if (pendingState.status !== "needsMigrations") {
        throw new Error(`Expected pending migrations, got ${pendingState.status}`);
      }
      expect(pendingState.pendingMigrations).toContain("0021_chief_vindicator.sql");

      const repair = await reconcilePendingMigrationHistory(connectionString);
      expect(repair.repairedMigrations).toEqual([]);
      expect(repair.remainingMigrations).toContain("0021_chief_vindicator.sql");

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'issues'
              AND column_name IN ('assignee_agent_runtime_overrides', 'assignee_adapter_overrides')
            ORDER BY column_name
          `,
        );
        expect(columns.map((row) => row.column_name)).toEqual([
          "assignee_agent_runtime_overrides",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "enforces a unique board_api_keys.key_hash after migration 0044",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`
          INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
          VALUES ('user-1', 'User One', 'user@example.com', true, now(), now())
        `);
        await sql.unsafe(`
          INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
          VALUES ('00000000-0000-0000-0000-000000000001', 'user-1', 'Key One', 'dup-hash', now())
        `);
        await expect(
          sql.unsafe(`
            INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
            VALUES ('00000000-0000-0000-0000-000000000002', 'user-1', 'Key Two', 'dup-hash', now())
          `),
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    },
    20_000,
  );
});
