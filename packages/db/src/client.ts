import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createMigrationManifest, type MigrationManifest } from "./migration-manifest.js";
import { applyMigrationsWithRust } from "./migration-operator.js";
import { resolveMigrationRecoveryDirectory } from "./runtime-config.js";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
export const MIGRATION_ADVISORY_LOCK_NAME = "rudder:database-migrations";

export type MigrationSourcePaths = Readonly<{
  migrationsFolder: string;
  journalFile: string;
}>;

export function getMigrationSourcePaths(): MigrationSourcePaths {
  return {
    migrationsFolder: MIGRATIONS_FOLDER,
    journalFile: MIGRATIONS_JOURNAL_JSON,
  };
}
// These hashes belong to previously applied migration revisions that were
// superseded by the current manifest but remain in existing journals. They are
// accepted as historical evidence; any other unknown journal hash fails closed.
const KNOWN_LEGACY_MIGRATION_HISTORY_IDENTIFIERS = new Set([
  "e21cac193575f50627e67946ef9afa44ddd17af24627c8799c5024ce534f89e3",
  "fdf8b69236a60593c52be53ebff89d7f581ddbdbde0227081b11c53b1f6d6578",
  "fba251275287250b3f05a5533e00d3941a3b1c1a526d0073e5d636a2dd868f80",
  "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7",
  "31ba03166f91d84423463bf986219371786078bde80241379cab83d53a4df6d5",
  "e5c12f75cba0ee38da04e5175c762a4b3b5e9e9c523ea97f9956448b44e11570",
  "f48a179c17c3ae9b2b419a3f8d4ee8d78de6e4acec3a077fe0d4bcb9a73d57c6",
  "a531d1d8383becb9090492d1b763aeb11a4c2ade4f325a29500511900b29888d",
  "cbf2988159818d54929cda6119f3ca3b6cd6d265c08fb73c6221198ff99d070e",
  // Historical 0159_heartbeat_timer_cursor from the archived 2026-08-25 main snapshot.
  "0ba359cdf4244b5509bd9c8d7f9dee91e8d8e3967d56771770ecfc6114e0c958",
]);
const LEGACY_COLUMN_RENAMES = [
  { tableName: "agents", from: "adapter_type", to: "agent_runtime_type" },
  { tableName: "agents", from: "adapter_config", to: "agent_runtime_config" },
  { tableName: "agent_runtime_state", from: "adapter_type", to: "agent_runtime_type" },
  { tableName: "agent_task_sessions", from: "adapter_type", to: "agent_runtime_type" },
  { tableName: "join_requests", from: "adapter_type", to: "agent_runtime_type" },
  { tableName: "finance_events", from: "execution_adapter_type", to: "execution_agent_runtime_type" },
  { tableName: "issues", from: "assignee_adapter_overrides", to: "assignee_agent_runtime_overrides" },
] as const;

function createUtilitySql(url: string) {
  return postgres(url, { max: 1, onnotice: () => {} });
}

function buildPostgresConnectionString(opts: {
  host?: string;
  port: number;
  user: string;
  password: string;
  database?: string;
}): string {
  const host = opts.host ?? "127.0.0.1";
  const database = opts.database ?? "postgres";
  return `postgres://${encodeURIComponent(opts.user)}:${encodeURIComponent(opts.password)}@${host}:${opts.port}/${database}`;
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  if (!isSafeIdentifier(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export type MigrationState =
  | { status: "upToDate"; tableCount: number; availableMigrations: string[]; appliedMigrations: string[] }
  | {
      status: "needsMigrations";
      tableCount: number;
      availableMigrations: string[];
      appliedMigrations: string[];
      pendingMigrations: string[];
      reason: "no-migration-journal-empty-db" | "no-migration-journal-non-empty-db" | "pending-migrations" | "missing-core-schema";
    };

export type PostMigrationInvariantIssue = Readonly<{
  code:
    | "migration_manifest_invalid"
    | "migration_state_not_current"
    | "migration_journal_missing"
    | "migration_journal_invalid"
    | "organizations_table_missing"
    | "organizations_primary_key_invalid"
    | "foreign_keys_missing"
    | "foreign_keys_not_validated"
    | "indexes_invalid";
  message: string;
}>;

export type PostMigrationInvariantReport = Readonly<{
  valid: boolean;
  manifestFingerprint: string | null;
  expectedMigrationCount: number;
  migrationJournalSchema: string | null;
  migrationJournalEntryCount: number;
  organizationsTablePresent: boolean;
  organizationsPrimaryKeyValid: boolean;
  foreignKeyCount: number;
  unvalidatedForeignKeys: readonly string[];
  invalidIndexes: readonly string[];
  issues: readonly PostMigrationInvariantIssue[];
}>;

export function createDb(url: string) {
  const sql = postgres(url);
  return drizzlePg(sql, { schema });
}

async function readPostgresDataDirectory(url: string): Promise<string | null> {
  const sql = createUtilitySql(url);
  try {
    const rows = await sql<{ data_directory: string | null }[]>`
      SELECT current_setting('data_directory', true) AS data_directory
    `;
    const actual = rows[0]?.data_directory;
    return typeof actual === "string" && actual.length > 0 ? actual : null;
  } catch {
    return null;
  } finally {
    await sql.end();
  }
}

export async function getPostgresDataDirectory(url: string): Promise<string | null> {
  try {
    return await readPostgresDataDirectory(url);
  } catch {
    return null;
  }
}

export type EnsurePostgresRolePasswordOptions = {
  host?: string;
  port: number;
  user: string;
  database?: string;
  preferredPassword: string;
  fallbackPasswords?: string[];
  expectedDataDir?: string | null;
};

export type EnsurePostgresRolePasswordResult = {
  connectionString: string;
  password: string;
  normalized: boolean;
};

export async function ensurePostgresRolePassword(
  options: EnsurePostgresRolePasswordOptions,
): Promise<EnsurePostgresRolePasswordResult> {
  const candidatePasswords = Array.from(
    new Set([options.preferredPassword, ...(options.fallbackPasswords ?? [])].filter((value) => value.length > 0)),
  );

  let lastError: unknown = null;
  for (const password of candidatePasswords) {
    const connectionString = buildPostgresConnectionString({
      host: options.host,
      port: options.port,
      user: options.user,
      password,
      database: options.database,
    });

    try {
      const actualDataDir = await readPostgresDataDirectory(connectionString);
      if (
        options.expectedDataDir &&
        (!actualDataDir || resolve(actualDataDir) !== resolve(options.expectedDataDir))
      ) {
        continue;
      }

      if (password === options.preferredPassword) {
        return {
          connectionString,
          password,
          normalized: false,
        };
      }

      const sql = createUtilitySql(connectionString);
      try {
        await sql.unsafe(
          `ALTER ROLE ${quoteIdentifier(options.user)} WITH PASSWORD ${quoteLiteral(options.preferredPassword)}`,
        );
      } finally {
        await sql.end();
      }

      const normalizedConnectionString = buildPostgresConnectionString({
        host: options.host,
        port: options.port,
        user: options.user,
        password: options.preferredPassword,
        database: options.database,
      });
      const normalizedDataDir = await readPostgresDataDirectory(normalizedConnectionString);
      if (
        options.expectedDataDir &&
        (!normalizedDataDir || resolve(normalizedDataDir) !== resolve(options.expectedDataDir))
      ) {
        throw new Error("PostgreSQL password normalization reached an unexpected data directory");
      }

      return {
        connectionString: normalizedConnectionString,
        password: options.preferredPassword,
        normalized: true,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error(`Unable to authenticate PostgreSQL user ${options.user}`);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_FOLDER, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

type MigrationJournalFile = {
  entries?: Array<{ idx?: number; tag?: string; when?: number }>;
};

type JournalMigrationEntry = {
  fileName: string;
  folderMillis: number;
  order: number;
};

async function listJournalMigrationEntries(): Promise<JournalMigrationEntry[]> {
  try {
    const raw = await readFile(MIGRATIONS_JOURNAL_JSON, "utf8");
    const parsed = JSON.parse(raw) as MigrationJournalFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries
      .map((entry, entryIndex) => {
        if (typeof entry?.tag !== "string") return null;
        if (typeof entry?.when !== "number" || !Number.isFinite(entry.when)) return null;
        const order = Number.isInteger(entry.idx) ? Number(entry.idx) : entryIndex;
        return { fileName: `${entry.tag}.sql`, folderMillis: entry.when, order };
      })
      .filter((entry): entry is JournalMigrationEntry => entry !== null);
  } catch {
    return [];
  }
}

async function listJournalMigrationFiles(): Promise<string[]> {
  const entries = await listJournalMigrationEntries();
  return entries.map((entry) => entry.fileName);
}

async function readMigrationFileContent(migrationFile: string): Promise<string> {
  return readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;
// Migration execution and recovery are delegated to the Rust operator. This
// compatibility entry point intentionally contains no Node SQL writer.

async function mapHashesToMigrationFiles(migrationFiles: string[]): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();

  await Promise.all(
    migrationFiles.map(async (migrationFile) => {
      const content = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(content).digest("hex");
      mapped.set(hash, migrationFile);
    }),
  );

  return mapped;
}

async function getMigrationTableColumnNames(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
): Promise<Set<string>> {
  const columns = await sql.unsafe<{ column_name: string }[]>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${quoteLiteral(migrationTableSchema)}
        AND table_name = ${quoteLiteral(DRIZZLE_MIGRATIONS_TABLE)}
    `,
  );
  return new Set(columns.map((column) => column.column_name));
}

async function tableExists(
  sql: ReturnType<typeof postgres>,
  tableName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function columnExists(
  sql: SqlExecutor,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const rows = await sql.unsafe<{ exists: boolean }[]>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${quoteLiteral(tableName)}
          AND column_name = ${quoteLiteral(columnName)}
      ) AS exists
    `,
  );
  return rows[0]?.exists ?? false;
}

async function findLegacyColumnRenames(sql: SqlExecutor): Promise<typeof LEGACY_COLUMN_RENAMES[number][]> {
  const pending: typeof LEGACY_COLUMN_RENAMES[number][] = [];
  for (const rename of LEGACY_COLUMN_RENAMES) {
    const fromExists = await columnExists(sql, rename.tableName, rename.from);
    if (!fromExists) continue;

    const toExists = await columnExists(sql, rename.tableName, rename.to);
    if (!toExists) pending.push(rename);
  }
  return pending;
}

export async function listLegacyColumnRenames(url: string): Promise<string[]> {
  const sql = createUtilitySql(url);
  try {
    const pending = await findLegacyColumnRenames(sql);
    return pending.map(({ tableName, from, to }) => `${tableName}.${from}->${to}`);
  } finally {
    await sql.end();
  }
}

async function loadAppliedMigrations(
  sql: ReturnType<typeof postgres>,
  migrationTableSchema: string,
  availableMigrations: string[],
): Promise<string[]> {
  const quotedSchema = quoteIdentifier(migrationTableSchema);
  const qualifiedTable = `${quotedSchema}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);

  if (columnNames.has("name")) {
    const rows = await sql.unsafe<{ name: string }[]>(`SELECT name FROM ${qualifiedTable} ORDER BY id`);
    return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
  }

  if (columnNames.has("hash")) {
    const rows = await sql.unsafe<{ hash: string }[]>(`SELECT hash FROM ${qualifiedTable} ORDER BY id`);
    const hashesToMigrationFiles = await mapHashesToMigrationFiles(availableMigrations);
    const appliedFromHashes = rows
      .map((row) => hashesToMigrationFiles.get(row.hash))
      .filter((name): name is string => Boolean(name));

    if (appliedFromHashes.length > 0) {
      // Best-effort: when all hashes resolve, this is authoritative.
      if (appliedFromHashes.length === rows.length) return appliedFromHashes;

      // Partial hash resolution can happen when files have changed; return what we can trust.
      return appliedFromHashes;
    }

    // Fallback only when hashes are unavailable/unresolved.
    if (columnNames.has("created_at")) {
      const journalEntries = await listJournalMigrationEntries();
      if (journalEntries.length > 0) {
        const lastDbRows = await sql.unsafe<{ created_at: string | number | null }[]>(
          `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC LIMIT 1`,
        );
        const lastCreatedAt = Number(lastDbRows[0]?.created_at ?? -1);
        if (Number.isFinite(lastCreatedAt) && lastCreatedAt >= 0) {
          return journalEntries
            .filter((entry) => availableMigrations.includes(entry.fileName))
            .filter((entry) => entry.folderMillis <= lastCreatedAt)
            .map((entry) => entry.fileName)
            .slice(0, rows.length);
        }
      }
    }
  }

  const rows = await sql.unsafe<{ id: number }[]>(`SELECT id FROM ${qualifiedTable} ORDER BY id`);
  const journalMigrationFiles = await listJournalMigrationFiles();
  const appliedFromIds = rows
    .map((row) => journalMigrationFiles[row.id - 1])
    .filter((name): name is string => Boolean(name));
  if (appliedFromIds.length > 0) return appliedFromIds;

  return availableMigrations.slice(0, Math.max(0, rows.length));
}

async function discoverMigrationTableSchema(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const rows = await sql<{ schemaName: string }[]>`
    SELECT n.nspname AS "schemaName"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = ${DRIZZLE_MIGRATIONS_TABLE} AND c.relkind = 'r'
  `;

  if (rows.length === 0) return null;

  const drizzleSchema = rows.find(({ schemaName }) => schemaName === "drizzle");
  if (drizzleSchema) return drizzleSchema.schemaName;

  const publicSchema = rows.find(({ schemaName }) => schemaName === "public");
  if (publicSchema) return publicSchema.schemaName;

  return rows[0]?.schemaName ?? null;
}

export async function inspectMigrations(url: string): Promise<MigrationState> {
  const sql = createUtilitySql(url);

  try {
    const availableMigrations = await listMigrationFiles();
    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;
    const tableCount = tableCountResult[0]?.count ?? 0;

    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      if (tableCount > 0) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations: [],
          pendingMigrations: availableMigrations,
          reason: "no-migration-journal-non-empty-db",
        };
      }

      return {
        status: "needsMigrations",
        tableCount,
        availableMigrations,
        appliedMigrations: [],
        pendingMigrations: availableMigrations,
        reason: "no-migration-journal-empty-db",
      };
    }

    const appliedMigrations = await loadAppliedMigrations(sql, migrationTableSchema, availableMigrations);
    const pendingMigrations = availableMigrations.filter((name) => !appliedMigrations.includes(name));
    if (pendingMigrations.length === 0) {
      const hasOrganizationsTable = await tableExists(sql, "organizations");
      if (!hasOrganizationsTable) {
        return {
          status: "needsMigrations",
          tableCount,
          availableMigrations,
          appliedMigrations,
          pendingMigrations: availableMigrations,
          reason: "missing-core-schema",
        };
      }

      return {
        status: "upToDate",
        tableCount,
        availableMigrations,
        appliedMigrations,
      };
    }

    return {
      status: "needsMigrations",
      tableCount,
      availableMigrations,
      appliedMigrations,
      pendingMigrations,
      reason: "pending-migrations",
    };
  } finally {
    await sql.end();
  }
}

export async function validatePostMigrationInvariants(
  url: string,
): Promise<PostMigrationInvariantReport> {
  const issues: PostMigrationInvariantIssue[] = [];
  let manifestFingerprint: string | null = null;
  let expectedMigrationCount = 0;
  let expectedManifest: MigrationManifest | null = null;

  try {
    const manifest = await createMigrationManifest();
    expectedManifest = manifest;
    manifestFingerprint = manifest.fingerprint;
    expectedMigrationCount = manifest.entries.length;
  } catch (error) {
    issues.push({
      code: "migration_manifest_invalid",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const state = await inspectMigrations(url);
  if (state.status !== "upToDate") {
    issues.push({
      code: "migration_state_not_current",
      message: `Database migrations are not current (${state.reason}: ${state.pendingMigrations.join(", ")})`,
    });
  }

  const sql = createUtilitySql(url);
  let migrationJournalSchema: string | null = null;
  let migrationJournalEntryCount = 0;
  let organizationsTablePresent = false;
  let organizationsPrimaryKeyValid = false;
  let foreignKeyCount = 0;
  let unvalidatedForeignKeys: string[] = [];
  let invalidIndexes: string[] = [];

  try {
    migrationJournalSchema = await discoverMigrationTableSchema(sql);
    if (!migrationJournalSchema) {
      issues.push({
        code: "migration_journal_missing",
        message: "Migration journal table is missing",
      });
    } else {
      const qualifiedTable = `${quoteIdentifier(migrationJournalSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
      const columnNames = await getMigrationTableColumnNames(sql, migrationJournalSchema);
      const journalRows = await sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM ${qualifiedTable}`,
      );
      migrationJournalEntryCount = Number(journalRows[0]?.count ?? 0);
      if (
        !columnNames.has("created_at")
        || (!columnNames.has("hash") && !columnNames.has("name"))
      ) {
        issues.push({
          code: "migration_journal_invalid",
          message: "Migration journal must contain created_at and either hash or name",
        });
      } else if (expectedManifest) {
        const selectedColumns = [
          columnNames.has("id") ? "id" : null,
          columnNames.has("hash") ? "hash" : null,
          columnNames.has("name") ? "name" : null,
          "created_at",
        ].filter((column): column is string => column !== null);
        const orderColumn = columnNames.has("id") ? "id" : "created_at";
        const journalEntries = await sql.unsafe<Array<Record<string, unknown>>>(
          `SELECT ${selectedColumns.map(quoteIdentifier).join(", ")} FROM ${qualifiedTable} ORDER BY ${quoteIdentifier(orderColumn)}`,
        );
        const expectedByHash = new Map(expectedManifest.entries.map((entry) => [entry.sha256, entry]));
        const expectedByName = new Map(expectedManifest.entries.map((entry) => [entry.fileName, entry]));
        const matchedExpectedFiles = new Set<string>();
        if (journalEntries.length < expectedManifest.entries.length) {
          issues.push({
            code: "migration_journal_invalid",
            message: `Migration journal has ${journalEntries.length} entries; expected at least ${expectedManifest.entries.length}`,
          });
        }
        for (let index = 0; index < journalEntries.length; index += 1) {
          const actual = journalEntries[index];
          const actualHash = typeof actual?.hash === "string" ? actual.hash : null;
          const actualName = typeof actual?.name === "string" ? actual.name : null;
          const expectedByActualHash = actualHash ? expectedByHash.get(actualHash) : undefined;
          const expectedByActualName = actualName ? expectedByName.get(actualName) : undefined;
          const matchedExpected = expectedByActualHash ?? expectedByActualName;
          if (matchedExpected) {
            if (matchedExpectedFiles.has(matchedExpected.fileName)) {
              issues.push({
                code: "migration_journal_invalid",
                message: `Migration journal contains duplicate history for ${matchedExpected.fileName}`,
              });
            }
            matchedExpectedFiles.add(matchedExpected.fileName);
          } else {
            const isKnownLegacyHash = actualHash !== null
              && KNOWN_LEGACY_MIGRATION_HISTORY_IDENTIFIERS.has(actualHash);
            if (!isKnownLegacyHash) {
              issues.push({
                code: "migration_journal_invalid",
                message: `Migration journal entry ${index} does not match any current migration manifest entry`,
              });
            }
          }
          if (
            (expectedByActualHash && actualName !== null && actualName !== expectedByActualHash.fileName)
            || (expectedByActualName && actualHash !== null && actualHash !== expectedByActualName.sha256)
          ) {
            issues.push({
              code: "migration_journal_invalid",
              message: `Migration journal entry ${index} does not match its current migration manifest entry`,
            });
          }
        }
        const missingExpectedFiles = expectedManifest.entries
          .map((entry) => entry.fileName)
          .filter((fileName) => !matchedExpectedFiles.has(fileName));
        if (missingExpectedFiles.length > 0) {
          issues.push({
            code: "migration_journal_invalid",
            message: `Migration journal is missing current migration(s): ${missingExpectedFiles.join(", ")}`,
          });
        }
      }
    }

    organizationsTablePresent = await tableExists(sql, "organizations");
    if (!organizationsTablePresent) {
      issues.push({
        code: "organizations_table_missing",
        message: "Core organizations table is missing",
      });
    }

    const primaryKeyRows = await sql.unsafe<{ constraint_name: string }[]>(`
      SELECT constraint_row.conname AS constraint_name
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      JOIN pg_index index_row ON index_row.indexrelid = constraint_row.conindid
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = 'organizations'
        AND constraint_row.contype = 'p'
        AND constraint_row.convalidated
        AND index_row.indisvalid
        AND index_row.indisready
    `);
    organizationsPrimaryKeyValid = primaryKeyRows.length === 1;
    if (!organizationsPrimaryKeyValid) {
      issues.push({
        code: "organizations_primary_key_invalid",
        message: "Core organizations primary key is missing or invalid",
      });
    }

    const foreignKeyCountRows = await sql.unsafe<{ count: number }[]>(`
      SELECT count(*)::int AS count
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND constraint_row.contype = 'f'
    `);
    foreignKeyCount = Number(foreignKeyCountRows[0]?.count ?? 0);
    if (foreignKeyCount === 0) {
      issues.push({
        code: "foreign_keys_missing",
        message: "No public foreign key constraints were found",
      });
    }

    const unvalidatedForeignKeyRows = await sql.unsafe<{ constraint_name: string }[]>(`
      SELECT table_row.relname || '.' || constraint_row.conname AS constraint_name
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND constraint_row.contype = 'f'
        AND NOT constraint_row.convalidated
      ORDER BY table_row.relname, constraint_row.conname
    `);
    unvalidatedForeignKeys = unvalidatedForeignKeyRows.map((row) => row.constraint_name);
    if (unvalidatedForeignKeys.length > 0) {
      issues.push({
        code: "foreign_keys_not_validated",
        message: `Unvalidated foreign keys: ${unvalidatedForeignKeys.join(", ")}`,
      });
    }

    const invalidIndexRows = await sql.unsafe<{ index_name: string }[]>(`
      SELECT table_row.relname || '.' || index_row.relname AS index_name
      FROM pg_index index_state
      JOIN pg_class index_row ON index_row.oid = index_state.indexrelid
      JOIN pg_class table_row ON table_row.oid = index_state.indrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND (NOT index_state.indisvalid OR NOT index_state.indisready)
      ORDER BY table_row.relname, index_row.relname
    `);
    invalidIndexes = invalidIndexRows.map((row) => row.index_name);
    if (invalidIndexes.length > 0) {
      issues.push({
        code: "indexes_invalid",
        message: `Invalid indexes: ${invalidIndexes.join(", ")}`,
      });
    }
  } finally {
    await sql.end();
  }

  return Object.freeze({
    valid: issues.length === 0,
    manifestFingerprint,
    expectedMigrationCount,
    migrationJournalSchema,
    migrationJournalEntryCount,
    organizationsTablePresent,
    organizationsPrimaryKeyValid,
    foreignKeyCount,
    unvalidatedForeignKeys: Object.freeze(unvalidatedForeignKeys),
    invalidIndexes: Object.freeze(invalidIndexes),
    issues: Object.freeze(issues),
  });
}

export async function assertPostMigrationInvariants(url: string): Promise<void> {
  const report = await validatePostMigrationInvariants(url);
  if (!report.valid) {
    throw new Error(
      `Post-migration database invariants failed: ${report.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
}

export async function applyPendingMigrations(url: string): Promise<void> {
  const source = getMigrationSourcePaths();
  await applyMigrationsWithRust({
    databaseUrl: url,
    migrationsDir: source.migrationsFolder,
    journalFile: source.journalFile,
    recoveryDirectory: resolveMigrationRecoveryDirectory(),
    postgresBinDir: process.env.RUDDER_POSTGRES_BIN_DIR?.trim() || undefined,
  });
}

export async function ensurePostgresDatabase(
  url: string,
  databaseName: string,
): Promise<"created" | "exists"> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Unsafe database name: ${databaseName}`);
  }

  const sql = createUtilitySql(url);
  try {
    const existing = await sql<{ one: number }[]>`
      select 1 as one from pg_database where datname = ${databaseName} limit 1
    `;
    if (existing.length > 0) return "exists";

    await sql.unsafe(`create database "${databaseName}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    return "created";
  } finally {
    await sql.end();
  }
}

export type Db = ReturnType<typeof createDb>;
