import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "../packages/db/node_modules/postgres/src/index.js";
import {
  createLocalPostgresInstance,
  type LocalPostgresInstance,
} from "../packages/db/src/local-postgres-provider.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustManifest = path.join(repoRoot, "native/Cargo.toml");
const schema = "rudder.migration-preflight/v1";
const protocolVersion = 1;
const databaseUrlEnv = "RUDDER_MIGRATION_PREFLIGHT_DATABASE_URL";
const advisoryLockName = "rudder.migrations.v1";
const temporaryRoots: string[] = [];

type SqlClient = ReturnType<typeof postgres>;

type RustRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type Fixture = {
  root: string;
  migrationsDir: string;
  journalFile: string;
  migrationHash: string;
};

type PreflightResponse = {
  schema: string;
  protocolVersion: number;
  status: string;
  report?: {
    status: string;
  };
  error?: {
    classification: string;
    code: string;
    message: string;
  };
};

type TableSignature = {
  table_schema: string;
  table_name: string;
  table_type: string;
};

type HistorySignature = {
  id: string;
  hash: string | null;
  created_at: string | null;
};

type DatabaseSignature = {
  tables: TableSignature[];
  history: HistorySignature[];
};

function spawnProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input = "",
  timeoutMs = 30_000,
): Promise<RustRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function cliEnv(databaseUrl?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[databaseUrlEnv];
  if (databaseUrl !== undefined) env[databaseUrlEnv] = databaseUrl;
  return env;
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-migration-preflight-"));
  temporaryRoots.push(root);
  const migrationsDir = path.join(root, "migrations");
  const metaDir = path.join(migrationsDir, "meta");
  mkdirSync(metaDir, { recursive: true });

  const migrationFile = path.join(migrationsDir, "0000_first.sql");
  const migrationSql = "SELECT 1;\n";
  writeFileSync(migrationFile, migrationSql);
  const journalFile = path.join(metaDir, "_journal.json");
  writeFileSync(
    journalFile,
    JSON.stringify({
      version: "7",
      dialect: "postgresql",
      entries: [{
        idx: 0,
        version: "7",
        when: 1000,
        tag: "0000_first",
        breakpoints: true,
      }],
    }),
  );
  return {
    root,
    migrationsDir,
    journalFile,
    migrationHash: createHash("sha256").update(readFileSync(migrationFile)).digest("hex"),
  };
}

function preflightRequest(fixture: Fixture, migrationsDir = fixture.migrationsDir): string {
  return JSON.stringify({
    schema,
    protocolVersion,
    source: {
      migrationsDir,
      journalFile: fixture.journalFile,
    },
  });
}

async function buildRustBinary(targetDir: string): Promise<string> {
  const build = await spawnProcess(
    "cargo",
    [
      "build",
      "--quiet",
      "--locked",
      "--manifest-path",
      rustManifest,
      "--package",
      "rudder-migration-service",
      "--bin",
      "migration-preflight",
      "--target-dir",
      targetDir,
    ],
    { ...process.env, CARGO_TARGET_DIR: targetDir },
  );
  assert.equal(build.exitCode, 0, "migration-preflight binary build failed");
  assert.equal(build.signal, null, "migration-preflight binary build was signalled");
  const binary = path.join(
    targetDir,
    "debug",
    process.platform === "win32" ? "migration-preflight.exe" : "migration-preflight",
  );
  assert.equal(existsSync(binary), true, "cargo build did not produce migration-preflight");
  return binary;
}

function parseResponse(run: RustRun, label: string): PreflightResponse {
  assert.equal(run.stderr, "", `${label} emitted stderr`);
  assert.notEqual(run.stdout.trim(), "", `${label} produced no JSON`);
  const response = JSON.parse(run.stdout) as PreflightResponse;
  assert.equal(response.schema, schema, `${label} schema`);
  assert.equal(response.protocolVersion, protocolVersion, `${label} protocol version`);
  return response;
}

async function runCli(
  binary: string,
  input: string,
  databaseUrl: string | undefined,
  expectedExitCode: number,
  label: string,
): Promise<{ response: PreflightResponse; run: RustRun }> {
  const run = await spawnProcess(binary, [], cliEnv(databaseUrl), input);
  assert.equal(run.exitCode, expectedExitCode, `${label} exit code`);
  assert.equal(run.signal, null, `${label} signal`);
  return { response: parseResponse(run, label), run };
}

function assertDoesNotLeak(run: RustRun, secret: string, label: string): void {
  assert.equal(run.stdout.includes(secret), false, `${label} leaked secret to stdout`);
  assert.equal(run.stderr.includes(secret), false, `${label} leaked secret to stderr`);
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new Error("temporary PostgreSQL listener did not expose a port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function resetDatabase(sql: SqlClient): Promise<void> {
  await sql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await sql`DROP TABLE IF EXISTS public.organizations`;
  await sql`DROP TABLE IF EXISTS public.preflight_legacy_fixture`;
}

async function createJournal(sql: SqlClient, hash?: string): Promise<void> {
  await sql`CREATE SCHEMA drizzle`;
  await sql`CREATE TABLE drizzle.__drizzle_migrations (
    id bigint NOT NULL,
    hash text,
    created_at bigint
  )`;
  if (hash !== undefined) {
    await sql`
      INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
      VALUES (1, ${hash}, 1000)
    `;
  }
}

async function databaseSignature(sql: SqlClient): Promise<string> {
  const tables = await sql<TableSignature[]>`
    SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema IN ('public', 'drizzle')
    ORDER BY table_schema, table_name, table_type
  `;
  const relation = await sql<{ is_present: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS is_present
  `;
  const history = relation[0]?.is_present
    ? await sql<HistorySignature[]>`
        SELECT id, hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY id
      `
    : [];
  const signature: DatabaseSignature = {
    tables: tables.map((row) => ({
      table_schema: row.table_schema,
      table_name: row.table_name,
      table_type: row.table_type,
    })),
    history: history.map((row) => ({
      id: String(row.id),
      hash: row.hash,
      created_at: row.created_at === null ? null : String(row.created_at),
    })),
  };
  return JSON.stringify(signature);
}

async function assertReadOnlyTransactionContract(sql: SqlClient): Promise<void> {
  await assert.rejects(
    sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const settings = await transaction<{ transaction_read_only: string }[]>`
        SHOW transaction_read_only
      `;
      assert.equal(settings[0]?.transaction_read_only, "on");
      await transaction`CREATE TEMP TABLE migration_preflight_write_probe (id integer)`;
    }),
    /read-only/i,
    "read-only transaction accepted a write",
  );
}

type Setup = (sql: SqlClient, fixture: Fixture) => Promise<void>;

async function assertBusinessStatus(
  binary: string,
  databaseUrl: string,
  fixture: Fixture,
  sql: SqlClient,
  expectedStatus: string,
  label: string,
  setup: Setup,
): Promise<void> {
  await resetDatabase(sql);
  await setup(sql, fixture);
  const before = await databaseSignature(sql);
  const { response } = await runCli(
    binary,
    preflightRequest(fixture),
    databaseUrl,
    0,
    label,
  );
  assert.equal(response.status, expectedStatus, `${label} top-level status`);
  assert.equal(response.report?.status, expectedStatus, `${label} report status`);
  assert.equal(response.error, undefined, `${label} unexpectedly returned an error`);
  assert.equal(await databaseSignature(sql), before, `${label} changed database state`);
}

async function assertUnlockedByAdvisoryLock(
  binary: string,
  databaseUrl: string,
  fixture: Fixture,
  sql: SqlClient,
): Promise<void> {
  await resetDatabase(sql);
  await createJournal(sql, fixture.migrationHash);
  await sql`CREATE TABLE public.organizations (id uuid PRIMARY KEY)`;
  const before = await databaseSignature(sql);
  const lockSql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await lockSql`SELECT pg_advisory_lock(hashtext(${advisoryLockName}))`;
    const startedAt = Date.now();
    const { response } = await runCli(
      binary,
      preflightRequest(fixture),
      databaseUrl,
      0,
      "advisory lock does not block preflight",
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, "current");
    assert.ok(elapsedMs < 5_000, `preflight took ${elapsedMs}ms while advisory lock was held`);
    assert.equal(await databaseSignature(sql), before, "advisory-lock preflight changed database state");
  } finally {
    await lockSql`SELECT pg_advisory_unlock(hashtext(${advisoryLockName}))`.catch(() => undefined);
    await lockSql.end({ timeout: 0 });
  }
}

async function assertProtocolBoundaries(
  binary: string,
  fixture: Fixture,
  databaseUrl: string,
): Promise<void> {
  const malformedSecret = "malformed-db-password-secret";
  const malformed = await runCli(
    binary,
    `{not-json-${malformedSecret}`,
    undefined,
    2,
    "malformed protocol input",
  );
  assert.equal(malformed.response.status, "error");
  assert.equal(malformed.response.error?.code, "invalid_json");
  assertDoesNotLeak(malformed.run, malformedSecret, "malformed protocol input");

  const relativeSecret = "relative/db-password-secret";
  const relative = await runCli(
    binary,
    JSON.stringify({
      schema,
      protocolVersion,
      source: { migrationsDir: relativeSecret },
    }),
    undefined,
    2,
    "relative source path",
  );
  assert.equal(relative.response.error?.code, "source_path_invalid");
  assertDoesNotLeak(relative.run, relativeSecret, "relative source path");

  const invalidProtocolSecret = "invalid-protocol-db-password-secret";
  const invalidProtocol = await runCli(
    binary,
    preflightRequest(fixture),
    `file://user:${invalidProtocolSecret}@database.invalid/rudder`,
    2,
    "invalid database URL protocol",
  );
  assert.equal(invalidProtocol.response.error?.code, "database_url_protocol_unsupported");
  assertDoesNotLeak(invalidProtocol.run, invalidProtocolSecret, "invalid database URL protocol");

  const connectionSecret = "connection-db-password-secret";
  const failedConnection = await runCli(
    binary,
    preflightRequest(fixture),
    `postgres://user:${connectionSecret}@127.0.0.1:1/rudder`,
    2,
    "failed database connection",
  );
  assert.equal(failedConnection.response.error?.code, "database_connect_failed");
  assertDoesNotLeak(failedConnection.run, connectionSecret, "failed database connection");

  const missingDatabaseUrl = await runCli(
    binary,
    preflightRequest(fixture),
    undefined,
    2,
    "missing database URL",
  );
  assert.equal(missingDatabaseUrl.response.error?.code, "database_url_missing");
  assertDoesNotLeak(missingDatabaseUrl.run, fixture.root, "missing database URL");

  assert.ok(databaseUrl.startsWith("postgres://"));
}

async function main(): Promise<void> {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), "rudder-migration-preflight-target-"));
  temporaryRoots.push(targetDir);
  const binary = await buildRustBinary(targetDir);
  const fixture = createFixture();
  const port = await findFreePort();
  const password = "rudder-preflight-disposable-secret";
  const databaseDir = mkdtempSync(path.join(os.tmpdir(), "rudder-migration-preflight-postgres-"));
  temporaryRoots.push(databaseDir);
  let instance: LocalPostgresInstance | undefined;
  let sql: SqlClient | undefined;
  const databaseUrl = `postgres://rudder:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;

  try {
    const selection = await createLocalPostgresInstance({
      databaseDir,
      user: "rudder",
      password,
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: (message) => process.stderr.write(`[preflight-postgres:init] ${String(message)}\n`),
      onError: (message) => process.stderr.write(`[preflight-postgres:error] ${String(message)}\n`),
    });
    instance = selection.instance;
    await instance.initialise();
    await instance.start();
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
    await sql`SELECT 1`;

    await assertReadOnlyTransactionContract(sql);
    await assertProtocolBoundaries(binary, fixture, databaseUrl);
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "bootstrap", "bootstrap", async (db) => {
      await resetDatabase(db);
    });
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "pending", "pending", async (db) => {
      await createJournal(db);
    });
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "current", "current", async (db, item) => {
      await createJournal(db, item.migrationHash);
      await db`CREATE TABLE public.organizations (id uuid PRIMARY KEY)`;
    });
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "mismatch", "mismatch", async (db) => {
      await createJournal(db, "wrong-migration-hash");
    });
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "missing-core-schema", "missing core schema", async (db, item) => {
      await createJournal(db, item.migrationHash);
    });
    await assertBusinessStatus(binary, databaseUrl, fixture, sql, "unsafe-legacy", "unsafe legacy", async (db) => {
      await db`CREATE TABLE public.preflight_legacy_fixture (id integer PRIMARY KEY)`;
    });
    await assertUnlockedByAdvisoryLock(binary, databaseUrl, fixture, sql);
    console.log("PASS migration-preflight CLI disposable PostgreSQL verifier");
  } finally {
    if (sql) await sql.end({ timeout: 0 }).catch(() => undefined);
    if (instance) await instance.stop().catch(() => undefined);
    for (const root of temporaryRoots.splice(0).reverse()) {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, `temporary verifier root was not cleaned: ${root}`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
