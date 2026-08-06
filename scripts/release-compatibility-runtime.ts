import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  applyPendingMigrations,
  cleanupStaleSysvSharedMemorySegments,
  inspectMigrations,
  validatePostMigrationInvariants,
} from "../packages/db/src/index.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const requireFromDb = createRequire(path.join(REPO_ROOT, "packages/db/package.json"));
const postgresModule = requireFromDb("postgres") as { default?: (...args: any[]) => any } | ((...args: any[]) => any);
const postgres = ("default" in postgresModule ? postgresModule.default : postgresModule) as (...args: any[]) => any;
const { drizzle: drizzlePg } = requireFromDb("drizzle-orm/postgres-js") as { drizzle: (...args: any[]) => any };
const { migrate: migratePg } = requireFromDb("drizzle-orm/postgres-js/migrator") as { migrate: (...args: any[]) => Promise<void> };
const MIGRATION_PATH = "packages/db/src/migrations";
const FIXTURES = ["v0.7.1", "v0.7.0", "v0.6.5"] as const;
const IDS = {
  organization: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  issue: "00000000-0000-4000-8000-000000000003",
  run: "00000000-0000-4000-8000-000000000004",
  conversation: "00000000-0000-4000-8000-000000000005",
  message: "00000000-0000-4000-8000-000000000006",
  user: "compatibility-user",
  account: "compatibility-account",
  membership: "00000000-0000-4000-8000-000000000007",
  grant: "00000000-0000-4000-8000-000000000008",
};

function gitShow(ref: string, file: string): string {
  return execFileSync("git", ["-C", REPO_ROOT, "show", `${ref}:${file}`], { encoding: "utf8" });
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${serialized.replaceAll("'", "''")}'`;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function materializeMigrations(ref: string, root: string): Promise<string> {
  const folder = path.join(root, ref.replaceAll("/", "-"));
  const meta = path.join(folder, "meta");
  await mkdir(meta, { recursive: true });
  const journalPath = `${MIGRATION_PATH}/meta/_journal.json`;
  const journal = JSON.parse(gitShow(ref, journalPath)) as { entries?: Array<{ tag?: string }> };
  for (const entry of journal.entries ?? []) {
    if (!entry.tag) throw new Error(`${ref} has a journal entry without a tag`);
    await writeFile(path.join(folder, `${entry.tag}.sql`), gitShow(ref, `${MIGRATION_PATH}/${entry.tag}.sql`));
  }
  await writeFile(path.join(meta, "_journal.json"), JSON.stringify(journal));
  return folder;
}

async function startDatabase(root: string): Promise<{
  connectionString: string;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
}> {
  await cleanupStaleSysvSharedMemorySegments().catch(() => undefined);
  const { default: EmbeddedPostgres } = requireFromDb("embedded-postgres") as { default: new (options: any) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> } };
  const port = await availablePort();
  const dataDir = path.join(root, "postgres");
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (message: unknown) => process.stderr.write(`[compatibility-postgres:error] ${String(message)}\n`),
  });
  await instance.initialise();
  await instance.start();
  const admin = postgres(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, { max: 1, onnotice: () => {} });
  await admin`CREATE DATABASE rudder`;
  await admin.end();
  return {
    connectionString: `postgres://rudder:rudder@127.0.0.1:${port}/rudder`,
    stop: () => instance.stop(),
    restart: async () => {
      await instance.stop();
      await instance.start();
    },
  };
}

async function tableColumns(sql: ReturnType<typeof postgres>, tableName: string): Promise<Set<string>> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${tableName}
  `;
  return new Set(rows.map((row) => row.column_name));
}

async function insertIfPresent(
  sql: ReturnType<typeof postgres>,
  tableName: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const columns = await tableColumns(sql, tableName);
  if (columns.size === 0) return false;
  const selected = Object.entries(values).filter(([column]) => columns.has(column));
  if (selected.length === 0) return false;
  await sql.unsafe(
    `INSERT INTO "${tableName}" (${selected.map(([column]) => `"${column}"`).join(", ")}) `
      + `VALUES (${selected.map(([, value]) => sqlLiteral(value)).join(", ")}) ON CONFLICT DO NOTHING`,
  );
  return true;
}

async function seedProductionShape(sql: ReturnType<typeof postgres>): Promise<void> {
  const now = new Date().toISOString();
  const organizationTable = (await tableColumns(sql, "organizations")).size > 0 ? "organizations" : "companies";
  const orgKey = organizationTable === "organizations" ? "org_id" : "company_id";
  await insertIfPresent(sql, organizationTable, {
    id: IDS.organization, url_key: "compatibility-org", name: "Compatibility Organization",
    description: "Historical upgrade fixture", status: "active", issue_prefix: "CMP",
    created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "agents", {
    id: IDS.agent, [orgKey]: IDS.organization, name: "Compatibility Agent", role: "engineer",
    status: "idle", agent_runtime_type: "process", adapter_type: "process", agent_runtime_config: {},
    adapter_config: {}, created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "user", {
    id: IDS.user, name: "Compatibility User", email: "compatibility@example.invalid",
    email_verified: true, created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "account", {
    id: IDS.account, account_id: "compatibility", provider_id: "credential", user_id: IDS.user,
    created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "issues", {
    id: IDS.issue, [orgKey]: IDS.organization, title: "Compatibility Task", description: "Preserve this row",
    status: "todo", priority: "high", assignee_agent_id: IDS.agent, created_by_agent_id: IDS.agent,
    created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "heartbeat_runs", {
    id: IDS.run, [orgKey]: IDS.organization, agent_id: IDS.agent, status: "completed",
    invocation_source: "manual", created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "chat_conversations", {
    id: IDS.conversation, [orgKey]: IDS.organization, title: "Compatibility Chat", status: "active",
    created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "chat_messages", {
    id: IDS.message, [orgKey]: IDS.organization, conversation_id: IDS.conversation,
    role: "user", body: "Preserve this conversation", created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "company_memberships", {
    id: IDS.membership, company_id: IDS.organization, principal_type: "user", principal_id: IDS.user,
    status: "active", membership_role: "member", created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "organization_memberships", {
    id: IDS.membership, org_id: IDS.organization, principal_type: "user", principal_id: IDS.user,
    status: "active", membership_role: "member", created_at: now, updated_at: now,
  });
  await insertIfPresent(sql, "principal_permission_grants", {
    id: IDS.grant, [orgKey]: IDS.organization, principal_type: "user", principal_id: IDS.user,
    permission_key: "issues.read", created_at: now, updated_at: now,
  });
}

async function countShape(sql: ReturnType<typeof postgres>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["organizations", "companies", "agents", "issues", "heartbeat_runs", "chat_conversations", "chat_messages", "user", "account", "company_memberships", "organization_memberships", "principal_permission_grants"]) {
    const columns = await tableColumns(sql, table);
    if (columns.size === 0) continue;
    const rows = await sql.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM "${table}"`);
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

async function runFixture(ref: string, root: string): Promise<void> {
  const fixtureRoot = path.join(root, ref.replaceAll("/", "-"));
  await mkdir(fixtureRoot, { recursive: true });
  const oldFolder = await materializeMigrations(ref, fixtureRoot);
  const db = await startDatabase(fixtureRoot);
  const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
  try {
    await migratePg(drizzlePg(sql), { migrationsFolder: oldFolder });
    await seedProductionShape(sql);
    const before = await countShape(sql);
    await sql.end();
    await applyPendingMigrations(db.connectionString);
    const upgradedSql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
    const state = await inspectMigrations(db.connectionString);
    if (state.status !== "upToDate") throw new Error(`${ref} remains pending after candidate migration`);
    const report = await validatePostMigrationInvariants(db.connectionString);
    if (!report.valid) throw new Error(`${ref} invariant failure: ${report.issues.map((issue) => issue.message).join("; ")}`);
    const after = await countShape(upgradedSql);
    await upgradedSql.end();
    for (const [table, count] of Object.entries(before)) {
      const upgradedTable = table === "companies" ? "organizations" : table === "company_memberships" ? "organization_memberships" : table;
      if (after[upgradedTable] !== count) throw new Error(`${ref} changed ${table} row count (${count} -> ${after[upgradedTable] ?? 0})`);
    }
    await db.restart();
    const restartedSql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
    const restarted = await countShape(restartedSql);
    await restartedSql.end();
    for (const [table, count] of Object.entries(after)) {
      if (restarted[table] !== count) throw new Error(`${ref} lost ${table} rows across restart`);
    }
    process.stdout.write(`verified ${ref}: ${Object.values(after).reduce((sum, count) => sum + count, 0)} shaped rows\n`);
  } finally {
    await sql.end().catch(() => undefined);
    await db.stop().catch(() => undefined);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "rudder-release-compatibility-"));
try {
  for (const ref of FIXTURES) await runFixture(ref, root);
} finally {
  await rm(root, { recursive: true, force: true });
}
