import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
let root: string;
let instance: EmbeddedPostgres;
let db: postgres.Sql;
let url: string;
let upgradedPending: { org: string; id: string };
const workers = new Set<ChildProcess>();

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await delay(30);
  }
  throw new Error("Timed out waiting for disposable outbox recovery");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rudder-outbox-recovery-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  instance = new EmbeddedPostgres({
    databaseDir: path.join(root, "postgres"), user: "rudder", password: "rudder",
    port, persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {}, onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  url = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  db = postgres(url, { max: 3, onnotice: () => {} });
  const migrationsFolder = path.join(repoRoot, "packages/db/src/migrations");
  const previousMigrations = path.join(root, "migrations-through-0173");
  await cp(migrationsFolder, previousMigrations, { recursive: true });
  const journalPath = path.join(previousMigrations, "meta/_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 173);
  await writeFile(journalPath, JSON.stringify(journal));
  await migrate(drizzle(db), { migrationsFolder: previousMigrations });
  upgradedPending = await seed();
  await migrate(drizzle(db), { migrationsFolder });
}, 120_000);

async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  workers.delete(child);
}
afterEach(async () => {
  await Promise.all([...workers].map(stop));
  // Only rows created inside this disposable database are removed.
  await db`DELETE FROM organization_mutation_outbox`;
});
afterAll(async () => {
  await db?.end({ timeout: 5 });
  await instance?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

async function seed() {
  const org = randomUUID();
  const activity = randomUUID();
  await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES (${org}, ${org}, 'Disposable recovery organization', ${org})`;
  await db`INSERT INTO activity_log (id, org_id, actor_id, action, entity_type, entity_id)
    VALUES (${activity}, ${org}, 'synthetic-board', 'organization.branding_updated', 'organization', ${org})`;
  const [row] = await db`INSERT INTO organization_mutation_outbox (org_id, activity_id, event_type, payload)
    VALUES (${org}, ${activity}, 'activity.logged', '{"action":"organization.branding_updated"}') RETURNING id`;
  return { org, id: row!.id as string };
}

function worker(org: string, mode: string) {
  const messages: Array<{ kind: string; dedupeKey?: string }> = [];
  const child = fork(path.join(repoRoot, "scripts/smoke/organization-outbox-recovery-worker.ts"), [mode], {
    cwd: repoRoot,
    execArgv: ["--import", path.join(repoRoot, "cli/node_modules/tsx/dist/loader.mjs")],
    env: { ...process.env, RUDDER_OUTBOX_TEST_DATABASE_URL: url, RUDDER_OUTBOX_TEST_ORG_ID: org },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr = `${stderr}${data}`.slice(-2000); });
  child.on("message", (message) => messages.push(message as typeof messages[number]));
  workers.add(child);
  return {
    child, messages,
    wait: (kind: string) => eventually(async () => {
      if (child.exitCode !== null) throw new Error(`Worker exited ${child.exitCode}: ${stderr}`);
      return messages.find((message) => message.kind === kind);
    }, Boolean),
  };
}

async function state(id: string) {
  const [row] = await db`SELECT state, attempts, claim_token, claim_owner, lease_expires_at, last_error,
    next_attempt_at > now() AS retry_delayed FROM organization_mutation_outbox WHERE id = ${id}`;
  return row!;
}

it("upgrades a stopped 0173 publisher's pending event and delivers it after 0174", async () => {
  expect(await state(upgradedPending.id)).toMatchObject({
    state: "pending", attempts: 0, claim_token: null, claim_owner: null, lease_expires_at: null,
  });
  const replacement = worker(upgradedPending.org, "normal");
  const event = await replacement.wait("published");
  expect(event?.dedupeKey).toBe(`organization-mutation-outbox:${upgradedPending.id}`);
  expect(await eventually(() => state(upgradedPending.id), (value) => value.state === "published"))
    .toMatchObject({ attempts: 1, claim_token: null, claim_owner: null, lease_expires_at: null });
}, 30_000);

it("recovers a committed claim after a publisher process is killed", async () => {
  const { org, id } = await seed();
  const first = worker(org, "hold-claim");
  await first.wait("claimed");
  expect(await state(id)).toMatchObject({ state: "claimed", attempts: 1 });
  await stop(first.child);
  const replacement = worker(org, "normal");
  await replacement.wait("published");
  const row = await eventually(() => state(id), (value) => value.state === "published");
  expect(row).toMatchObject({ attempts: 2, claim_token: null, claim_owner: null, lease_expires_at: null });
}, 30_000);

it("does not let a stale worker emit or ACK after another process reclaims", async () => {
  const { org, id } = await seed();
  const stale = worker(org, "hold-claim");
  await stale.wait("claimed");
  const replacement = worker(org, "normal");
  await replacement.wait("published");
  await eventually(() => state(id), (value) => value.state === "published");
  stale.child.send({ release: true });
  await stale.wait("drained");
  expect(stale.messages.filter((message) => message.kind === "published")).toEqual([]);
  expect(await state(id)).toMatchObject({ state: "published", attempts: 2 });
}, 30_000);

it("retries a crash after broadcast before ACK with the same delivery key", async () => {
  const { org, id } = await seed();
  const first = worker(org, "crash-before-ack");
  const before = await first.wait("published");
  await stop(first.child);
  const replacement = worker(org, "normal");
  const after = await replacement.wait("published");
  expect(after?.dedupeKey).toBe(before?.dedupeKey);
  expect(after?.dedupeKey).toBe(`organization-mutation-outbox:${id}`);
  expect(await eventually(() => state(id), (value) => value.state === "published")).toMatchObject({ attempts: 2 });
}, 30_000);

it("persists failed-publication backoff and recovers on process replacement", async () => {
  const { org, id } = await seed();
  const failing = worker(org, "fail-publication");
  await failing.wait("drained");
  expect(await state(id)).toMatchObject({
    state: "pending", attempts: 1, claim_token: null, retry_delayed: true,
    last_error: "disposable publication fault",
  });
  await stop(failing.child);
  const replacement = worker(org, "normal");
  await replacement.wait("published");
  expect(await eventually(() => state(id), (value) => value.state === "published"))
    .toMatchObject({ attempts: 2, last_error: null });
}, 30_000);
