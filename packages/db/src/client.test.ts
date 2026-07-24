import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
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

type MigrationJournalEntry = {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
};

type LegacyTerminalMigrationManifest = {
  sourceCommit: string;
  entries: Array<MigrationJournalEntry & { sha256: string }>;
};

function createLegacyTerminalMigrationsFolder() {
  const migrationsFolder = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-legacy-terminal-migrations-"));
  tempPaths.push(migrationsFolder);
  fs.mkdirSync(path.join(migrationsFolder, "meta"));

  const currentMigrationsUrl = new URL("./migrations/", import.meta.url);
  const currentJournal = JSON.parse(
    fs.readFileSync(new URL("meta/_journal.json", currentMigrationsUrl), "utf8"),
  ) as { version: string; dialect: string; entries: MigrationJournalEntry[] };
  const baseEntries = currentJournal.entries.filter((entry) => entry.idx < 102);
  if (baseEntries.at(-1)?.tag !== "0101_bizarre_morlun") {
    throw new Error("Legacy terminal migration fixture requires the 0101 base schema");
  }
  for (const entry of baseEntries) {
    fs.copyFileSync(
      new URL(`${entry.tag}.sql`, currentMigrationsUrl),
      path.join(migrationsFolder, `${entry.tag}.sql`),
    );
  }

  const fixtureUrl = new URL("./test-fixtures/legacy-terminal-state-migrations/", import.meta.url);
  const manifest = JSON.parse(
    fs.readFileSync(new URL("manifest.json", fixtureUrl), "utf8"),
  ) as LegacyTerminalMigrationManifest;
  for (const entry of manifest.entries) {
    const fixtureContent = fs.readFileSync(new URL(`${entry.tag}.sql`, fixtureUrl), "utf8");
    const normalizedFixtureContent = fixtureContent.replaceAll("\r\n", "\n");
    const historicalContent = normalizedFixtureContent.endsWith("\n")
      ? normalizedFixtureContent.slice(0, -1)
      : normalizedFixtureContent;
    const actualHash = createHash("sha256").update(historicalContent).digest("hex");
    if (actualHash !== entry.sha256) {
      throw new Error(
        `Legacy migration fixture hash mismatch for ${entry.tag}: expected ${entry.sha256}, received ${actualHash}`,
      );
    }
    fs.writeFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), historicalContent);
  }

  fs.writeFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({
      version: currentJournal.version,
      dialect: currentJournal.dialect,
      entries: [
        ...baseEntries,
        ...manifest.entries.map(({ sha256: _sha256, ...entry }) => entry),
      ],
    }),
  );
  return { manifest, migrationsFolder };
}

function createLegacyChatRuntimeControlsMigrationsFolder() {
  const migrationsFolder = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-legacy-chat-controls-migrations-"));
  tempPaths.push(migrationsFolder);
  fs.mkdirSync(path.join(migrationsFolder, "meta"));

  const currentMigrationsUrl = new URL("./migrations/", import.meta.url);
  const currentJournal = JSON.parse(
    fs.readFileSync(new URL("meta/_journal.json", currentMigrationsUrl), "utf8"),
  ) as { version: string; dialect: string; entries: MigrationJournalEntry[] };
  const baseEntries = currentJournal.entries.filter((entry) => entry.idx < 102);
  if (baseEntries.at(-1)?.tag !== "0101_bizarre_morlun") {
    throw new Error("Legacy chat control migration fixture requires the 0101 base schema");
  }
  for (const entry of baseEntries) {
    fs.copyFileSync(
      new URL(`${entry.tag}.sql`, currentMigrationsUrl),
      path.join(migrationsFolder, `${entry.tag}.sql`),
    );
  }

  const historicalContent = fs.readFileSync(
    new URL("0104_unusual_mister_fear.sql", currentMigrationsUrl),
    "utf8",
  );
  const historicalHash = createHash("sha256").update(historicalContent).digest("hex");
  if (historicalHash !== "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7") {
    throw new Error(`Legacy chat runtime controls fixture hash changed: ${historicalHash}`);
  }
  const legacyEntry: MigrationJournalEntry = {
    idx: 102,
    version: "7",
    when: 1784159513933,
    tag: "0102_chat_runtime_controls",
    breakpoints: true,
  };
  fs.writeFileSync(
    path.join(migrationsFolder, `${legacyEntry.tag}.sql`),
    historicalContent,
  );
  fs.writeFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({
      version: currentJournal.version,
      dialect: currentJournal.dialect,
      entries: [...baseEntries, legacyEntry],
    }),
  );
  return { historicalHash, migrationsFolder };
}

function createCurrentMigrationsFolderThrough(maxIdx: number) {
  const migrationsFolder = fs.mkdtempSync(path.join(os.tmpdir(), `rudder-migrations-through-${maxIdx}-`));
  tempPaths.push(migrationsFolder);
  fs.mkdirSync(path.join(migrationsFolder, "meta"));

  const currentMigrationsUrl = new URL("./migrations/", import.meta.url);
  const currentJournal = JSON.parse(
    fs.readFileSync(new URL("meta/_journal.json", currentMigrationsUrl), "utf8"),
  ) as { version: string; dialect: string; entries: MigrationJournalEntry[] };
  const entries = currentJournal.entries.filter((entry) => entry.idx <= maxIdx);
  for (const entry of entries) {
    fs.copyFileSync(
      new URL(`${entry.tag}.sql`, currentMigrationsUrl),
      path.join(migrationsFolder, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(
    path.join(migrationsFolder, "meta", "_journal.json"),
    JSON.stringify({
      version: currentJournal.version,
      dialect: currentJournal.dialect,
      entries,
    }),
  );
  return migrationsFolder;
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
    "completes migration 0100 when an older version already created the alias table",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const migration0100Hash = await migrationHash("0100_mean_richard_fisk.sql");
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES ('00000000-0000-0000-0000-000000000100', 'migration-recovery', 'Migration Recovery', 'MRC')
        `);
        await sql.unsafe(`
          INSERT INTO "organization_issue_prefix_aliases" ("org_id", "prefix")
          VALUES ('00000000-0000-0000-0000-000000000100', 'OLDMRC')
        `);

        await sql.unsafe(`DROP TRIGGER "organizations_route_key_namespace_trigger" ON "organizations"`);
        await sql.unsafe(
          `DROP TRIGGER "organization_alias_route_key_namespace_trigger" ON "organization_issue_prefix_aliases"`,
        );
        await sql.unsafe(`DROP FUNCTION "enforce_organization_route_key_namespace"()`);
        await sql.unsafe(`DROP FUNCTION "enforce_organization_alias_route_key_namespace"()`);
        await sql.unsafe(
          `ALTER TABLE "organization_issue_prefix_aliases" DROP CONSTRAINT "organization_issue_prefix_aliases_org_id_organizations_id_fk"`,
        );
        await sql.unsafe(`DROP INDEX "organization_issue_prefix_aliases_prefix_idx"`);
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${migration0100Hash}'`,
        );
        await sql.unsafe(`
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('legacy-0100-hash', 1783928221647)
        `);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0100_mean_richard_fisk.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const aliases = await verifySql.unsafe<{ prefix: string }[]>(
          `SELECT prefix FROM "organization_issue_prefix_aliases" ORDER BY prefix`,
        );
        expect(aliases.map((row) => row.prefix)).toEqual(["OLDMRC"]);

        const constraints = await verifySql.unsafe<{ conname: string }[]>(`
          SELECT conname
          FROM pg_constraint
          WHERE conname = 'organization_issue_prefix_aliases_org_id_organizations_id_fk'
        `);
        expect(constraints).toHaveLength(1);

        const indexes = await verifySql.unsafe<{ indexname: string }[]>(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'organization_issue_prefix_aliases_prefix_idx'
        `);
        expect(indexes).toHaveLength(1);

        const functions = await verifySql.unsafe<{ proname: string }[]>(`
          SELECT proname
          FROM pg_proc
          WHERE proname IN (
            'enforce_organization_route_key_namespace',
            'enforce_organization_alias_route_key_namespace'
          )
          ORDER BY proname
        `);
        expect(functions.map((row) => row.proname)).toEqual([
          "enforce_organization_alias_route_key_namespace",
          "enforce_organization_route_key_namespace",
        ]);

        const triggers = await verifySql.unsafe<{ tgname: string }[]>(`
          SELECT tgname
          FROM pg_trigger
          WHERE NOT tgisinternal
            AND tgname IN (
              'organizations_route_key_namespace_trigger',
              'organization_alias_route_key_namespace_trigger'
            )
          ORDER BY tgname
        `);
        expect(triggers.map((row) => row.tgname)).toEqual([
          "organization_alias_route_key_namespace_trigger",
          "organizations_route_key_namespace_trigger",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "reapplies consolidated migration 0102 over the legacy 0102-0104 feature shape",
    async () => {
      const connectionString = await createTempDatabase();
      const { manifest, migrationsFolder } = createLegacyTerminalMigrationsFolder();
      expect(manifest.sourceCommit).toBe("0491a75db25a24e644e67a502239fd1209840f40");

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await migratePg(drizzlePg(sql), { migrationsFolder });

        const legacyHistory = await sql.unsafe<{ hash: string; created_at: string }[]>(`
          SELECT hash, created_at
          FROM "drizzle"."__drizzle_migrations"
          ORDER BY created_at DESC
          LIMIT 3
        `);
        expect(legacyHistory.map((row) => ({
          hash: row.hash,
          createdAt: Number(row.created_at),
        }))).toEqual(
          [...manifest.entries].reverse().map((entry) => ({
            hash: entry.sha256,
            createdAt: entry.when,
          })),
        );

        const legacyColumns = await sql.unsafe<{ table_name: string; column_name: string }[]>(`
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN ('heartbeat_runs', 'cost_events')
            AND column_name IN (
              'terminal_effects_pending',
              'process_exited_at',
              'terminal_effects_json',
              'terminal_effects_last_error',
              'budget_evaluated_at',
              'execution_owner_token',
              'execution_lease_expires_at',
              'terminal_effects_completed_json'
            )
          ORDER BY table_name, column_name
        `);
        expect(legacyColumns).toEqual([
          { table_name: "cost_events", column_name: "budget_evaluated_at" },
          { table_name: "heartbeat_runs", column_name: "process_exited_at" },
          { table_name: "heartbeat_runs", column_name: "terminal_effects_json" },
          { table_name: "heartbeat_runs", column_name: "terminal_effects_last_error" },
          { table_name: "heartbeat_runs", column_name: "terminal_effects_pending" },
        ]);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [
          "0055_illegal_sheva_callister.sql",
          "0102_complex_retro_girl.sql",
          "0103_cute_colonel_america.sql",
          "0104_unusual_mister_fear.sql",
          "0105_chat_queue_actor_reconciliation.sql",
          "0106_damp_amphibian.sql",
          "0107_daffy_luke_cage.sql",
          "0108_atomic_chat_first_turn_cleanup.sql",
          "0109_many_carmella_unuscione.sql",
          "0110_supreme_mathemanic.sql",
          "0111_nostalgic_scarecrow.sql",
          "0112_yielding_starhawk.sql",
          "0113_nosy_doomsday.sql",
          "0114_nervous_firebird.sql",
          "0115_chubby_wraith.sql",
          "0116_dark_skreet.sql",
          "0117_reflective_namora.sql",
          "0118_flippant_longshot.sql",
        ],
        reason: "pending-migrations",
      });

      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const consolidatedHash = await migrationHash("0102_complex_retro_girl.sql");
        const consolidatedHistory = await verifySql.unsafe<{ hash: string }[]>(`
          SELECT hash
          FROM "drizzle"."__drizzle_migrations"
          WHERE hash = '${consolidatedHash}'
        `);
        expect(consolidatedHistory).toEqual([{ hash: consolidatedHash }]);
        const columns = await verifySql.unsafe<{ column_name: string }[]>(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'heartbeat_runs'
            AND column_name IN (
              'execution_owner_token',
              'execution_lease_expires_at',
              'session_params_after_json',
              'session_params_before_json',
              'session_reuse_scope',
              'terminal_effects_completed_json',
              'terminal_effects_last_error'
            )
          ORDER BY column_name
        `);
        expect(columns.map((row) => row.column_name)).toEqual([
          "execution_lease_expires_at",
          "execution_owner_token",
          "session_params_after_json",
          "session_params_before_json",
          "session_reuse_scope",
          "terminal_effects_completed_json",
          "terminal_effects_last_error",
        ]);
        const indexes = await verifySql.unsafe<{ indexname: string }[]>(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'heartbeat_runs_active_chat_conversation_uq',
              'heartbeat_runs_status_execution_lease_created_idx',
              'heartbeat_run_events_run_idempotency_key_uq'
            )
          ORDER BY indexname
        `);
        expect(indexes.map((row) => row.indexname)).toEqual([
          "heartbeat_run_events_run_idempotency_key_uq",
          "heartbeat_runs_active_chat_conversation_uq",
          "heartbeat_runs_status_execution_lease_created_idx",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "upgrades databases that applied the legacy 0102 chat runtime controls migration",
    async () => {
      const connectionString = await createTempDatabase();
      const { historicalHash, migrationsFolder } = createLegacyChatRuntimeControlsMigrationsFolder();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await migratePg(drizzlePg(sql), { migrationsFolder });
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES (
            '00000000-0000-0000-0000-000000000122',
            'legacy-chat-controls',
            'Legacy Chat Controls',
            'LCC'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "chat_conversations" ("id", "org_id", "title")
          VALUES (
            '00000000-0000-0000-0000-000000000123',
            '00000000-0000-0000-0000-000000000122',
            'Legacy chat runtime controls'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "chat_queued_messages" (
            "id",
            "org_id",
            "conversation_id",
            "position",
            "status",
            "client_mutation_id",
            "payload",
            "delivery_intent",
            "delivery_disposition"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000124',
            '00000000-0000-0000-0000-000000000122',
            '00000000-0000-0000-0000-000000000123',
            1,
            'continuation_pending',
            'legacy-wip-steer',
            '{"body":"legacy WIP steer"}'::jsonb,
            'steer',
            'continuation_pending'
          )
        `);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [
          "0055_illegal_sheva_callister.sql",
          "0102_complex_retro_girl.sql",
          "0103_cute_colonel_america.sql",
          "0105_chat_queue_actor_reconciliation.sql",
          "0106_damp_amphibian.sql",
          "0107_daffy_luke_cage.sql",
          "0108_atomic_chat_first_turn_cleanup.sql",
          "0109_many_carmella_unuscione.sql",
          "0110_supreme_mathemanic.sql",
          "0111_nostalgic_scarecrow.sql",
          "0112_yielding_starhawk.sql",
          "0113_nosy_doomsday.sql",
          "0114_nervous_firebird.sql",
          "0115_chubby_wraith.sql",
          "0116_dark_skreet.sql",
          "0117_reflective_namora.sql",
          "0118_flippant_longshot.sql",
        ],
        reason: "pending-migrations",
      });

      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const legacyHistory = await verifySql.unsafe<{ hash: string }[]>(`
          SELECT hash
          FROM "drizzle"."__drizzle_migrations"
          WHERE hash = '${historicalHash}'
        `);
        expect(legacyHistory).toEqual([{ hash: historicalHash }]);
        const [queueItem] = await verifySql.unsafe<{
          status: string;
          delivery_intent: string;
          delivery_disposition: string | null;
          request_actor: Record<string, unknown> | null;
          reconciliation_reason: string | null;
        }[]>(`
          SELECT
            status,
            delivery_intent,
            delivery_disposition,
            request_actor,
            reconciliation_reason
          FROM "chat_queued_messages"
          WHERE "id" = '00000000-0000-0000-0000-000000000124'
        `);
        expect(queueItem).toEqual({
          status: "queued",
          delivery_intent: "queue",
          delivery_disposition: null,
          request_actor: null,
          reconciliation_reason: "legacy_request_actor_unavailable",
        });
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "upgrades 0102 heartbeat runs with durable session lineage columns",
    async () => {
      const connectionString = await createTempDatabase();
      const migrationsThrough0102 = createCurrentMigrationsFolderThrough(102);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await migratePg(drizzlePg(sql), { migrationsFolder: migrationsThrough0102 });
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES ('00000000-0000-0000-0000-000000000103', 'session-lineage', 'Session Lineage', 'SLG')
        `);
        await sql.unsafe(`
          INSERT INTO "agents" ("id", "org_id", "name")
          VALUES (
            '00000000-0000-0000-0000-000000000104',
            '00000000-0000-0000-0000-000000000103',
            'Migration Agent'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "heartbeat_runs" ("id", "org_id", "agent_id")
          VALUES (
            '00000000-0000-0000-0000-000000000105',
            '00000000-0000-0000-0000-000000000103',
            '00000000-0000-0000-0000-000000000104'
          )
        `);
      } finally {
        await sql.end();
      }

      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [legacyRun] = await verifySql.unsafe<{
          session_params_before_json: Record<string, unknown> | null;
          session_params_after_json: Record<string, unknown> | null;
          session_reuse_scope: string;
        }[]>(`
          SELECT session_params_before_json, session_params_after_json, session_reuse_scope
          FROM "heartbeat_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000105'
        `);
        expect(legacyRun).toEqual({
          session_params_before_json: null,
          session_params_after_json: null,
          session_reuse_scope: "unknown",
        });

        for (const scope of ["explicit", "task", "none", "unknown"]) {
          await expect(verifySql.unsafe(`
            UPDATE "heartbeat_runs"
            SET "session_reuse_scope" = '${scope}',
                "session_params_before_json" = '{"sessionId":"before"}'::jsonb,
                "session_params_after_json" = '{"sessionId":"after"}'::jsonb
            WHERE "id" = '00000000-0000-0000-0000-000000000105'
          `)).resolves.toBeDefined();
        }
        await expect(verifySql.unsafe(`
          UPDATE "heartbeat_runs"
          SET "session_reuse_scope" = 'global'
          WHERE "id" = '00000000-0000-0000-0000-000000000105'
        `)).rejects.toMatchObject({ code: "23514" });
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "reconciles legacy chat control states before creating active-generation constraints",
    async () => {
      const connectionString = await createTempDatabase();
      const migrationsThrough0103 = createCurrentMigrationsFolderThrough(103);
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await migratePg(drizzlePg(sql), { migrationsFolder: migrationsThrough0103 });
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES (
            '00000000-0000-0000-0000-000000000110',
            'chat-control-migration',
            'Chat Control Migration',
            'CCM'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "agents" ("id", "org_id", "name")
          VALUES (
            '00000000-0000-0000-0000-000000000119',
            '00000000-0000-0000-0000-000000000110',
            'Legacy queue agent'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "chat_conversations" ("id", "org_id", "title")
          VALUES (
            '00000000-0000-0000-0000-000000000111',
            '00000000-0000-0000-0000-000000000110',
            'Legacy chat control state'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "chat_generations" ("id", "org_id", "conversation_id", "status")
          VALUES
            (
              '00000000-0000-0000-0000-000000000112',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              'active'
            ),
            (
              '00000000-0000-0000-0000-000000000113',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              'running'
            )
        `);
        await sql.unsafe(`
          INSERT INTO "chat_queued_messages" (
            "id",
            "org_id",
            "conversation_id",
            "position",
            "status",
            "client_mutation_id",
            "payload",
            "last_delivery_reason"
          )
          VALUES
            (
              '00000000-0000-0000-0000-000000000114',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              1,
              'steer_pending',
              'legacy-steer',
              '{"body":"steer"}'::jsonb,
              'unsupported'
            ),
            (
              '00000000-0000-0000-0000-000000000115',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              2,
              'dequeue_claimed',
              'legacy-claim',
              '{"body":"claim"}'::jsonb,
              NULL
            ),
            (
              '00000000-0000-0000-0000-000000000116',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              3,
              'running',
              'legacy-running',
              '{"body":"running"}'::jsonb,
              NULL
            ),
            (
              '00000000-0000-0000-0000-000000000117',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              4,
              'queued',
              'legacy-actorless-queue',
              '{"body":"actorless queue"}'::jsonb,
              NULL
            ),
            (
              '00000000-0000-0000-0000-000000000118',
              '00000000-0000-0000-0000-000000000110',
              '00000000-0000-0000-0000-000000000111',
              5,
              'steer_pending',
              'legacy-actorless-steer',
              '{"body":"actorless steer"}'::jsonb,
              'unsupported'
            )
        `);
        await sql.unsafe(`
          INSERT INTO "activity_log" (
            "id",
            "org_id",
            "actor_type",
            "actor_id",
            "action",
            "entity_type",
            "entity_id",
            "agent_id",
            "details"
          )
          VALUES
            (
              '00000000-0000-0000-0000-000000000120',
              '00000000-0000-0000-0000-000000000110',
              'user',
              'legacy-board-user',
              'chat.queue.created',
              'chat',
              '00000000-0000-0000-0000-000000000111',
              NULL,
              '{"queuedMessageId":"00000000-0000-0000-0000-000000000114"}'::jsonb
            ),
            (
              '00000000-0000-0000-0000-000000000121',
              '00000000-0000-0000-0000-000000000110',
              'agent',
              '00000000-0000-0000-0000-000000000119',
              'chat.queue.created',
              'chat',
              '00000000-0000-0000-0000-000000000111',
              '00000000-0000-0000-0000-000000000119',
              '{"queuedMessageId":"00000000-0000-0000-0000-000000000115"}'::jsonb
            )
        `);
      } finally {
        await sql.end();
      }

      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
      expect((await inspectMigrations(connectionString)).status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const generations = await verifySql.unsafe<{
          status: string;
          terminal_reason: string | null;
          control_state: string;
          runtime_terminal_recorded: boolean;
          completed_recorded: boolean;
        }[]>(`
          SELECT
            status,
            terminal_reason,
            control_state,
            runtime_terminal_at IS NOT NULL AS runtime_terminal_recorded,
            completed_at IS NOT NULL AS completed_recorded
          FROM "chat_generations"
          WHERE "conversation_id" = '00000000-0000-0000-0000-000000000111'
          ORDER BY "id"
        `);
        expect(generations).toEqual([
          {
            status: "aborted",
            terminal_reason: "ownerless_during_durable_control_migration",
            control_state: "terminal",
            runtime_terminal_recorded: true,
            completed_recorded: true,
          },
          {
            status: "aborted",
            terminal_reason: "ownerless_during_durable_control_migration",
            control_state: "terminal",
            runtime_terminal_recorded: true,
            completed_recorded: true,
          },
        ]);

        const queueItems = await verifySql.unsafe<{
          position: number;
          status: string;
          delivery_intent: string;
          delivery_disposition: string | null;
          request_actor: Record<string, unknown> | null;
          reconciliation_reason: string | null;
          last_delivery_reason: string | null;
        }[]>(`
          SELECT
            position,
            status,
            delivery_intent,
            delivery_disposition,
            request_actor,
            reconciliation_reason,
            last_delivery_reason
          FROM "chat_queued_messages"
          WHERE "conversation_id" = '00000000-0000-0000-0000-000000000111'
          ORDER BY "position"
        `);
        expect(queueItems).toEqual([
          {
            position: 1,
            status: "continuation_pending",
            delivery_intent: "steer",
            delivery_disposition: "continuation_pending",
            request_actor: {
              type: "board",
              source: "session",
              userId: "legacy-board-user",
              orgIds: ["00000000-0000-0000-0000-000000000110"],
              isInstanceAdmin: false,
            },
            reconciliation_reason: "legacy_steer_recovered_on_upgrade",
            last_delivery_reason: null,
          },
          {
            position: 2,
            status: "queued",
            delivery_intent: "queue",
            delivery_disposition: null,
            request_actor: {
              type: "agent",
              source: "agent_key",
              orgId: "00000000-0000-0000-0000-000000000110",
              agentId: "00000000-0000-0000-0000-000000000119",
            },
            reconciliation_reason: "legacy_claim_released_on_upgrade",
            last_delivery_reason: "legacy_claim_released_on_upgrade",
          },
          {
            position: 3,
            status: "failed_actionable",
            delivery_intent: "queue",
            delivery_disposition: "failed_actionable",
            request_actor: null,
            reconciliation_reason: "legacy_running_delivery_unconfirmed_on_upgrade",
            last_delivery_reason: "legacy_running_delivery_unconfirmed_on_upgrade",
          },
          {
            position: 4,
            status: "queued",
            delivery_intent: "queue",
            delivery_disposition: null,
            request_actor: null,
            reconciliation_reason: "legacy_request_actor_unavailable",
            last_delivery_reason: "legacy_request_actor_unavailable",
          },
          {
            position: 5,
            status: "queued",
            delivery_intent: "queue",
            delivery_disposition: null,
            request_actor: null,
            reconciliation_reason: "legacy_request_actor_unavailable",
            last_delivery_reason: "legacy_request_actor_unavailable",
          },
        ]);

        const activeIndex = await verifySql.unsafe<{ indexname: string }[]>(`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'chat_generations_active_conversation_uq'
        `);
        expect(activeIndex).toEqual([{ indexname: "chat_generations_active_conversation_uq" }]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "rolls back migration 0100 when a legacy alias conflicts with another organization route",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      const migration0100Hash = await migrationHash("0100_mean_richard_fisk.sql");
      try {
        await sql.unsafe(`DROP TRIGGER "organizations_route_key_namespace_trigger" ON "organizations"`);
        await sql.unsafe(
          `DROP TRIGGER "organization_alias_route_key_namespace_trigger" ON "organization_issue_prefix_aliases"`,
        );
        await sql.unsafe(`DROP FUNCTION "enforce_organization_route_key_namespace"()`);
        await sql.unsafe(`DROP FUNCTION "enforce_organization_alias_route_key_namespace"()`);
        await sql.unsafe(
          `ALTER TABLE "organization_issue_prefix_aliases" DROP CONSTRAINT "organization_issue_prefix_aliases_org_id_organizations_id_fk"`,
        );
        await sql.unsafe(`DROP INDEX "organization_issue_prefix_aliases_prefix_idx"`);
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${migration0100Hash}'`,
        );
        await sql.unsafe(`
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('legacy-conflicting-0100-hash', 1783928221647)
        `);
        await sql.unsafe(`
          INSERT INTO "organizations" ("id", "url_key", "name", "issue_prefix")
          VALUES
            ('00000000-0000-0000-0000-000000000101', 'legacy-owner', 'Legacy Owner', 'LOWN'),
            ('00000000-0000-0000-0000-000000000102', 'claimed-route', 'Claimed Route', 'CRTE')
        `);
        await sql.unsafe(`
          INSERT INTO "organization_issue_prefix_aliases" ("org_id", "prefix")
          VALUES ('00000000-0000-0000-0000-000000000101', 'CLAIMED-ROUTE')
        `);
      } finally {
        await sql.end();
      }

      await expect(applyPendingMigrations(connectionString)).rejects.toThrow(
        "Existing organization route identities and historical Issue Keys conflict case-insensitively",
      );

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0100_mean_richard_fisk.sql"],
        reason: "pending-migrations",
      });

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const migrationEntries = await verifySql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "drizzle"."__drizzle_migrations"
          WHERE hash = '${migration0100Hash}'
        `);
        expect(migrationEntries[0]?.count).toBe(0);

        const aliases = await verifySql.unsafe<{ prefix: string }[]>(
          `SELECT prefix FROM "organization_issue_prefix_aliases" ORDER BY prefix`,
        );
        expect(aliases.map((row) => row.prefix)).toEqual(["CLAIMED-ROUTE"]);

        const restoredObjects = await verifySql.unsafe<{ count: number }[]>(`
          SELECT (
            (SELECT count(*) FROM pg_constraint
              WHERE conname = 'organization_issue_prefix_aliases_org_id_organizations_id_fk')
            + (SELECT count(*) FROM pg_indexes
              WHERE schemaname = 'public'
                AND indexname = 'organization_issue_prefix_aliases_prefix_idx')
            + (SELECT count(*) FROM pg_proc
              WHERE proname IN (
                'enforce_organization_route_key_namespace',
                'enforce_organization_alias_route_key_namespace'
              ))
            + (SELECT count(*) FROM pg_trigger
              WHERE NOT tgisinternal
                AND tgname IN (
                  'organizations_route_key_namespace_trigger',
                  'organization_alias_route_key_namespace_trigger'
                ))
          )::int AS count
        `);
        expect(restoredObjects[0]?.count).toBe(0);
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
    "replays migration 0063 safely when the experimental settings column is already absent",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const flawlessToadHash = await migrationHash("0063_flawless_toad.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${flawlessToadHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'instance_settings'
              AND column_name = 'experimental'
          `,
        );
        expect(columns).toHaveLength(0);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0063_flawless_toad.sql"],
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
