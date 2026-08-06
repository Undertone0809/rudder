import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { createMigrationManifest, type MigrationManifest } from "./migration-manifest.js";
import * as schema from "./schema/index.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));
const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const MIGRATIONS_JOURNAL_JSON = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));
export const MIGRATION_ADVISORY_LOCK_NAME = "rudder:database-migrations";
// These hashes belong to migrations that were intentionally superseded by a
// consolidated migration but remain in existing journals. They are accepted
// as historical evidence; any other unknown journal hash fails closed.
const KNOWN_LEGACY_MIGRATION_HISTORY_IDENTIFIERS = new Set([
  "e21cac193575f50627e67946ef9afa44ddd17af24627c8799c5024ce534f89e3",
  "fdf8b69236a60593c52be53ebff89d7f581ddbdbde0227081b11c53b1f6d6578",
  "fba251275287250b3f05a5533e00d3941a3b1c1a526d0073e5d636a2dd868f80",
  "a1fc0446af5ec1640890bb9cf36208eab8dce6687c233029bd54e179613e1af7",
  "legacy-0100-hash",
  "legacy-conflicting-0100-hash",
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

function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
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

async function orderMigrationsByJournal(migrationFiles: string[]): Promise<string[]> {
  const journalEntries = await listJournalMigrationEntries();
  const orderByFileName = new Map(journalEntries.map((entry) => [entry.fileName, entry.order]));
  return [...migrationFiles].sort((left, right) => {
    const leftOrder = orderByFileName.get(left);
    const rightOrder = orderByFileName.get(right);
    if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
    if (leftOrder === undefined) return 1;
    if (rightOrder === undefined) return -1;
    if (leftOrder === rightOrder) return left.localeCompare(right);
    return leftOrder - rightOrder;
  });
}

type SqlExecutor = Pick<ReturnType<typeof postgres>, "unsafe">;

async function runInTransaction(sql: SqlExecutor, action: () => Promise<void>): Promise<void> {
  await sql.unsafe("BEGIN");
  try {
    await action();
    await sql.unsafe("COMMIT");
  } catch (error) {
    try {
      await sql.unsafe("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  }
}

async function latestMigrationCreatedAt(
  sql: SqlExecutor,
  qualifiedTable: string,
): Promise<number | null> {
  const rows = await sql.unsafe<{ created_at: string | number | null }[]>(
    `SELECT created_at FROM ${qualifiedTable} ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const value = Number(rows[0]?.created_at ?? Number.NaN);
  return Number.isFinite(value) ? value : null;
}

function normalizeFolderMillis(value: number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  return Date.now();
}

async function ensureMigrationJournalTable(
  sql: ReturnType<typeof postgres>,
): Promise<{ migrationTableSchema: string; columnNames: Set<string> }> {
  let migrationTableSchema = await discoverMigrationTableSchema(sql);
  if (!migrationTableSchema) {
    const drizzleSchema = quoteIdentifier("drizzle");
    const migrationTable = quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${drizzleSchema}`);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${drizzleSchema}.${migrationTable} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
    );
    migrationTableSchema = (await discoverMigrationTableSchema(sql)) ?? "drizzle";
  }

  const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
  return { migrationTableSchema, columnNames };
}

async function migrationHistoryEntryExists(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
): Promise<boolean> {
  const predicates: string[] = [];
  if (columnNames.has("hash")) predicates.push(`hash = ${quoteLiteral(hash)}`);
  if (columnNames.has("name")) predicates.push(`name = ${quoteLiteral(migrationFile)}`);
  if (predicates.length === 0) return false;

  const rows = await sql.unsafe<{ one: number }[]>(
    `SELECT 1 AS one FROM ${qualifiedTable} WHERE ${predicates.join(" OR ")} LIMIT 1`,
  );
  return rows.length > 0;
}

async function recordMigrationHistoryEntry(
  sql: SqlExecutor,
  qualifiedTable: string,
  columnNames: Set<string>,
  migrationFile: string,
  hash: string,
  folderMillis: number,
): Promise<void> {
  const insertColumns: string[] = [];
  const insertValues: string[] = [];

  if (columnNames.has("hash")) {
    insertColumns.push(quoteIdentifier("hash"));
    insertValues.push(quoteLiteral(hash));
  }
  if (columnNames.has("name")) {
    insertColumns.push(quoteIdentifier("name"));
    insertValues.push(quoteLiteral(migrationFile));
  }
  if (columnNames.has("created_at")) {
    const latestCreatedAt = await latestMigrationCreatedAt(sql, qualifiedTable);
    const createdAt = latestCreatedAt === null
      ? normalizeFolderMillis(folderMillis)
      : Math.max(latestCreatedAt + 1, normalizeFolderMillis(folderMillis));
    insertColumns.push(quoteIdentifier("created_at"));
    insertValues.push(quoteLiteral(String(createdAt)));
  }

  if (insertColumns.length === 0) return;

  await sql.unsafe(
    `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
  );
}

async function applyPendingMigrationsManually(
  url: string,
  pendingMigrations: string[],
): Promise<void> {
  if (pendingMigrations.length === 0) return;

  const orderedPendingMigrations = await orderMigrationsByJournal(pendingMigrations);
  const journalEntries = await listJournalMigrationEntries();
  const folderMillisByFileName = new Map(
    journalEntries.map((entry) => [entry.fileName, normalizeFolderMillis(entry.folderMillis)]),
  );

  const sql = createUtilitySql(url);
  try {
    const { migrationTableSchema, columnNames } = await ensureMigrationJournalTable(sql);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of orderedPendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const existingEntry = await migrationHistoryEntryExists(
        sql,
        qualifiedTable,
        columnNames,
        migrationFile,
        hash,
      );
      if (existingEntry) continue;

      await runInTransaction(sql, async () => {
        for (const statement of splitMigrationStatements(migrationContent)) {
          await sql.unsafe(statement);
        }

        await recordMigrationHistoryEntry(
          sql,
          qualifiedTable,
          columnNames,
          migrationFile,
          hash,
          folderMillisByFileName.get(migrationFile) ?? Date.now(),
        );
      });
    }
  } finally {
    await sql.end();
  }
}

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

async function getColumnMetadata(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  columnName: string,
): Promise<{ exists: boolean; columnDefault: string | null; isNullable: boolean } | null> {
  const rows = await sql<{
    exists: boolean;
    columnDefault: string | null;
    isNullable: "YES" | "NO";
  }[]>`
    SELECT true AS exists,
      column_default AS "columnDefault",
      is_nullable AS "isNullable"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${tableName}
      AND column_name = ${columnName}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    exists: row.exists,
    columnDefault: row.columnDefault,
    isNullable: row.isNullable === "YES",
  };
}

async function indexExists(
  sql: ReturnType<typeof postgres>,
  indexName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ${indexName}
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

async function constraintExists(
  sql: ReturnType<typeof postgres>,
  constraintName: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public'
        AND c.conname = ${constraintName}
    ) AS exists
  `;
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

export async function normalizeLegacyColumnNames(url: string): Promise<string[]> {
  const sql = createUtilitySql(url);
  const repaired: string[] = [];

  try {
    await sql.begin(async (transaction) => {
      const pending = await findLegacyColumnRenames(transaction);
      for (const rename of pending) {
        await transaction.unsafe(
          `ALTER TABLE ${quoteIdentifier(rename.tableName)} RENAME COLUMN ${quoteIdentifier(rename.from)} TO ${quoteIdentifier(rename.to)}`,
        );
        repaired.push(`${rename.tableName}.${rename.from}->${rename.to}`);
      }
    });
  } finally {
    await sql.end();
  }

  return repaired;
}

async function migrationStatementAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  statement: string,
): Promise<boolean> {
  const normalized = statement.replace(/\s+/g, " ").trim();

  const createTableMatch = normalized.match(/^CREATE TABLE(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createTableMatch) {
    return tableExists(sql, createTableMatch[1]);
  }

  const addColumnMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ADD COLUMN(?: IF NOT EXISTS)? "([^"]+)"/i,
  );
  if (addColumnMatch) {
    return columnExists(sql, addColumnMatch[1], addColumnMatch[2]);
  }

  const createIndexMatch = normalized.match(/^CREATE (?:UNIQUE )?INDEX(?: IF NOT EXISTS)? "([^"]+)"/i);
  if (createIndexMatch) {
    return indexExists(sql, createIndexMatch[1]);
  }

  const addConstraintMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/i);
  if (addConstraintMatch) {
    return constraintExists(sql, addConstraintMatch[2]);
  }

  const alterColumnSetDefaultMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET DEFAULT (.+)$/i,
  );
  if (alterColumnSetDefaultMatch) {
    const [, tableName, columnName, nextDefault] = alterColumnSetDefaultMatch;
    const metadata = await getColumnMetadata(sql, tableName, columnName);
    if (!metadata?.exists) return false;
    if (metadata.columnDefault == null) return false;

    const normalizeDefault = (value: string) =>
      value.replace(/\s+/g, " ").trim().toLowerCase();

    return normalizeDefault(metadata.columnDefault).includes(normalizeDefault(nextDefault));
  }

  const alterColumnDropNotNullMatch = normalized.match(
    /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" DROP NOT NULL$/i,
  );
  if (alterColumnDropNotNullMatch) {
    const [, tableName, columnName] = alterColumnDropNotNullMatch;
    const metadata = await getColumnMetadata(sql, tableName, columnName);
    return metadata?.exists === true && metadata.isNullable;
  }

  // If we cannot reason about a statement safely, require manual migration.
  return false;
}

async function migrationContentAlreadyApplied(
  sql: ReturnType<typeof postgres>,
  migrationContent: string,
): Promise<boolean> {
  const statements = splitMigrationStatements(migrationContent);
  if (statements.length === 0) return false;

  for (const statement of statements) {
    const applied = await migrationStatementAlreadyApplied(sql, statement);
    if (!applied) return false;
  }

  return true;
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

export type MigrationHistoryReconcileResult = {
  repairedMigrations: string[];
  remainingMigrations: string[];
};

export async function reconcilePendingMigrationHistory(
  url: string,
): Promise<MigrationHistoryReconcileResult> {
  const state = await inspectMigrations(url);
  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    return { repairedMigrations: [], remainingMigrations: [] };
  }

  const sql = createUtilitySql(url);
  const repairedMigrations: string[] = [];

  try {
    const journalEntries = await listJournalMigrationEntries();
    const folderMillisByFile = new Map(journalEntries.map((entry) => [entry.fileName, entry.folderMillis]));
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) {
      return { repairedMigrations, remainingMigrations: state.pendingMigrations };
    }

    const columnNames = await getMigrationTableColumnNames(sql, migrationTableSchema);
    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;

    for (const migrationFile of state.pendingMigrations) {
      const migrationContent = await readMigrationFileContent(migrationFile);
      const hash = createHash("sha256").update(migrationContent).digest("hex");
      const folderMillis = folderMillisByFile.get(migrationFile) ?? Date.now();
      const existingByHash = columnNames.has("hash")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE hash = ${quoteLiteral(hash)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      const existingByName = columnNames.has("name")
        ? await sql.unsafe<{ created_at: string | number | null }[]>(
            `SELECT created_at FROM ${qualifiedTable} WHERE name = ${quoteLiteral(migrationFile)} ORDER BY created_at DESC LIMIT 1`,
          )
        : [];
      if (existingByHash.length > 0 || existingByName.length > 0) {
        if (columnNames.has("created_at")) {
          const existingHashCreatedAt = Number(existingByHash[0]?.created_at ?? -1);
          if (existingByHash.length > 0 && Number.isFinite(existingHashCreatedAt) && existingHashCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE hash = ${quoteLiteral(hash)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }

          const existingNameCreatedAt = Number(existingByName[0]?.created_at ?? -1);
          if (existingByName.length > 0 && Number.isFinite(existingNameCreatedAt) && existingNameCreatedAt < folderMillis) {
            await sql.unsafe(
              `UPDATE ${qualifiedTable} SET created_at = ${quoteLiteral(String(folderMillis))} WHERE name = ${quoteLiteral(migrationFile)} AND created_at < ${quoteLiteral(String(folderMillis))}`,
            );
          }
        }

        repairedMigrations.push(migrationFile);
        continue;
      }

      const alreadyApplied = await migrationContentAlreadyApplied(sql, migrationContent);
      if (!alreadyApplied) break;

      const insertColumns: string[] = [];
      const insertValues: string[] = [];

      if (columnNames.has("hash")) {
        insertColumns.push(quoteIdentifier("hash"));
        insertValues.push(quoteLiteral(hash));
      }
      if (columnNames.has("name")) {
        insertColumns.push(quoteIdentifier("name"));
        insertValues.push(quoteLiteral(migrationFile));
      }
      if (columnNames.has("created_at")) {
        insertColumns.push(quoteIdentifier("created_at"));
        insertValues.push(quoteLiteral(String(folderMillis)));
      }

      if (insertColumns.length === 0) break;

      await sql.unsafe(
        `INSERT INTO ${qualifiedTable} (${insertColumns.join(", ")}) VALUES (${insertValues.join(", ")})`,
      );
      repairedMigrations.push(migrationFile);
    }
  } finally {
    await sql.end();
  }

  const refreshed = await inspectMigrations(url);
  return {
    repairedMigrations,
    remainingMigrations:
      refreshed.status === "needsMigrations" ? refreshed.pendingMigrations : [],
  };
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

async function clearMigrationJournal(url: string): Promise<void> {
  const sql = createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);
    if (!migrationTableSchema) return;

    const qualifiedTable = `${quoteIdentifier(migrationTableSchema)}.${quoteIdentifier(DRIZZLE_MIGRATIONS_TABLE)}`;
    await sql.unsafe(`DROP TABLE IF EXISTS ${qualifiedTable}`);
    if (migrationTableSchema === "drizzle") {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdentifier("drizzle")}`);
    }
  } finally {
    await sql.end();
  }
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

export async function withMigrationAdvisoryLock<T>(
  url: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockSql = createUtilitySql(url);
  try {
    await lockSql`
      SELECT pg_advisory_lock(
        hashtext(current_database()),
        hashtext(${MIGRATION_ADVISORY_LOCK_NAME})
      )
    `;
    return await action();
  } finally {
    try {
      await lockSql`
        SELECT pg_advisory_unlock(
          hashtext(current_database()),
          hashtext(${MIGRATION_ADVISORY_LOCK_NAME})
        )
      `;
    } finally {
      await lockSql.end();
    }
  }
}

async function applyPendingMigrationsWithoutLock(url: string): Promise<void> {
  await normalizeLegacyColumnNames(url);
  const initialState = await inspectMigrations(url);
  if (initialState.status === "upToDate") return;

  if (initialState.reason === "missing-core-schema") {
    if (initialState.tableCount > 0) {
      throw new Error(
        "Migration journal claims the database is up to date, but required core tables are missing. " +
          "Refusing automatic repair because the public schema is not empty.",
      );
    }

    await clearMigrationJournal(url);
  }

  const repairedInitialState = await inspectMigrations(url);
  if (repairedInitialState.status === "upToDate") return;

  if (repairedInitialState.reason === "no-migration-journal-empty-db") {
    const sql = createUtilitySql(url);
    try {
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await sql.end();
    }

    let bootstrappedState = await inspectMigrations(url);
    if (bootstrappedState.status === "upToDate") return;
    if (bootstrappedState.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(url);
      if (repair.repairedMigrations.length > 0) {
        bootstrappedState = await inspectMigrations(url);
      }
      if (bootstrappedState.status === "needsMigrations" && bootstrappedState.reason === "pending-migrations") {
        await applyPendingMigrationsManually(url, bootstrappedState.pendingMigrations);
        bootstrappedState = await inspectMigrations(url);
      }
    }
    if (bootstrappedState.status === "upToDate") return;
    throw new Error(
      `Failed to bootstrap migrations: ${bootstrappedState.pendingMigrations.join(", ")}`,
    );
  }

  if (repairedInitialState.reason === "no-migration-journal-non-empty-db") {
    throw new Error(
      "Database has tables but no migration journal; automatic migration is unsafe. Initialize migration history manually.",
    );
  }

  let state = await inspectMigrations(url);
  if (state.status === "upToDate") return;

  const repair = await reconcilePendingMigrationHistory(url);
  if (repair.repairedMigrations.length > 0) {
    state = await inspectMigrations(url);
    if (state.status === "upToDate") return;
  }

  if (state.status !== "needsMigrations" || state.reason !== "pending-migrations") {
    throw new Error("Migrations are still pending after migration-history reconciliation; run inspectMigrations for details.");
  }

  await applyPendingMigrationsManually(url, state.pendingMigrations);

  const finalState = await inspectMigrations(url);
  if (finalState.status !== "upToDate") {
    throw new Error(
      `Failed to apply pending migrations: ${finalState.pendingMigrations.join(", ")}`,
    );
  }
}

export async function applyPendingMigrations(
  url: string,
  options: { advisoryLockHeld?: boolean } = {},
): Promise<void> {
  const apply = async () => {
    await createMigrationManifest();
    await applyPendingMigrationsWithoutLock(url);
    await assertPostMigrationInvariants(url);
  };

  if (options.advisoryLockHeld) {
    await apply();
    return;
  }

  await withMigrationAdvisoryLock(url, apply);
}

export type MigrationBootstrapResult =
  | { migrated: true; reason: "migrated-empty-db"; tableCount: 0 }
  | { migrated: false; reason: "already-migrated"; tableCount: number }
  | { migrated: false; reason: "not-empty-no-migration-journal"; tableCount: number };

export async function migratePostgresIfEmpty(url: string): Promise<MigrationBootstrapResult> {
  const sql = createUtilitySql(url);

  try {
    const migrationTableSchema = await discoverMigrationTableSchema(sql);

    const tableCountResult = await sql<{ count: number }[]>`
      select count(*)::int as count
      from information_schema.tables
      where table_schema = 'public'
        and table_type = 'BASE TABLE'
    `;

    const tableCount = tableCountResult[0]?.count ?? 0;

    if (migrationTableSchema) {
      return { migrated: false, reason: "already-migrated", tableCount };
    }

    if (tableCount > 0) {
      return { migrated: false, reason: "not-empty-no-migration-journal", tableCount };
    }

    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER });

    return { migrated: true, reason: "migrated-empty-db", tableCount: 0 };
  } finally {
    await sql.end();
  }
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
