import EmbeddedPostgres from "embedded-postgres";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";

let root: string;
let instance: EmbeddedPostgres | undefined;
let source: postgres.Sql | undefined;
let restored: postgres.Sql | undefined;
let sourceUrl: string;
let restoredUrl: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rudder-backup-authority-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No disposable PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
  instance = new EmbeddedPostgres({
    databaseDir: join(root, "postgres"), user: "rudder", password: "rudder", port,
    persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {}, onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const admin = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(admin, "source");
  await ensurePostgresDatabase(admin, "restored");
  sourceUrl = `postgres://rudder:rudder@127.0.0.1:${port}/source`;
  restoredUrl = `postgres://rudder:rudder@127.0.0.1:${port}/restored`;
  source = postgres(sourceUrl, { max: 1, onnotice: () => {} });
  restored = postgres(restoredUrl, { max: 1, onnotice: () => {} });
  await applyPendingMigrations(sourceUrl);
}, 120_000);

afterAll(async () => {
  await source?.end({ timeout: 5 });
  await restored?.end({ timeout: 5 });
  await instance?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

it("restores Project provisioning, monotonic fences and immutable receipts without migration replay", async () => {
  const db = source!;
  const clone = restored!;
  const org = randomUUID();
  const project = randomUUID();
  const audit = randomUUID();
  await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES (${org}, ${org}, 'Synthetic backup organization', ${org})`;
  await db`INSERT INTO projects (id, org_id, name) VALUES (${project}, ${org}, 'Persisted Rust project')`;
  await db`UPDATE project_goal_mutation_state
    SET owner = 'rust', mutation_version = 9, fence_epoch = 1, fence_token = gen_random_uuid()
    WHERE project_id = ${project}`;
  await db`INSERT INTO activity_log (id, org_id, actor_id, action, entity_type, entity_id)
    VALUES (${audit}, ${org}, 'synthetic-board', 'project.created', 'project', ${project})`;
  await db`INSERT INTO organization_mutation_receipts
    (org_id, idempotency_key, command_kind, command_fingerprint, outcome,
     resulting_version, fence_epoch, activity_id, result)
    VALUES (${org}, 'backup-create', 'project_create', ${"a".repeat(64)}, 'applied', 1, 0, ${audit},
      ${db.json({ organization_id: org, version: 1, fence_epoch: 0 })})`;
  // Historical violations are legal only for a NOT VALID check; future writes are not.
  await db`CREATE TABLE backup_check_fixture (id integer)`;
  await db`INSERT INTO backup_check_fixture VALUES (-1)`;
  await db`ALTER TABLE backup_check_fixture ADD CONSTRAINT positive_id CHECK (id > 0) NOT VALID`;
  await db`CREATE TABLE backup_trigger_fixture (id integer)`;
  await db`CREATE TABLE backup_trigger_events (id integer)`;
  await db.unsafe(`CREATE FUNCTION backup_always_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO backup_trigger_events VALUES (NEW.id); RETURN NEW; END; $$`);
  await db`CREATE TRIGGER backup_always AFTER INSERT ON backup_trigger_fixture
    FOR EACH ROW EXECUTE FUNCTION backup_always_event()`;
  await db`ALTER TABLE backup_trigger_fixture ENABLE ALWAYS TRIGGER backup_always`;
  await db`INSERT INTO backup_trigger_fixture VALUES (1)`;
  await db`CREATE TABLE backup_temporal_precision_fixture
    (id integer PRIMARY KEY, instant timestamptz, wall_clock timestamp)`;
  await db`INSERT INTO backup_temporal_precision_fixture VALUES
    (1, '2026-10-03 02:00:00.123456+00', '2026-10-03 02:00:00.654321')`;
  const temporalQuery = `SELECT id, to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS instant,
    to_char(wall_clock, 'YYYY-MM-DD HH24:MI:SS.US') AS wall_clock
    FROM backup_temporal_precision_fixture ORDER BY id`;
  const originalTemporalValues = await db.unsafe(temporalQuery);
  const originalFence = await db`SELECT * FROM project_goal_mutation_state WHERE project_id = ${project}`;
  const backup = await runDatabaseBackup({
    connectionString: sourceUrl, backupDir: join(root, "backups"), retentionDays: 1,
    includeMigrationJournal: true,
  });
  await runDatabaseRestore({ connectionString: restoredUrl, backupFile: backup.backupFile });
  // Database text, not JS Date equality: Date parsers hide sub-millisecond loss.
  expect(await clone.unsafe(temporalQuery)).toEqual(originalTemporalValues);
  // Deliberately do not migrate the clone: worktree init preserves this journal.
  expect(await clone`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`)
    .toEqual(await db`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`);
  expect(await clone`SELECT * FROM project_goal_mutation_state WHERE project_id = ${project}`).toEqual(originalFence);
  const fresh = randomUUID();
  await clone`INSERT INTO projects (id, org_id, name) VALUES (${fresh}, ${org}, 'New Node project')`;
  expect(await clone`SELECT owner, mutation_version::text, fence_epoch::text
    FROM project_goal_mutation_state WHERE project_id = ${fresh}`)
    .toEqual([{ owner: "node", mutation_version: "0", fence_epoch: "0" }]);
  // A stale writer cannot reset the restored owner/fence or erase live authority.
  await expect(clone`UPDATE project_goal_mutation_state SET owner = 'node'
    WHERE project_id = ${project}`).rejects.toMatchObject({ code: "23514" });
  await expect(clone`UPDATE project_goal_mutation_state SET mutation_version = 8
    WHERE project_id = ${project}`).rejects.toMatchObject({ code: "23514" });
  await expect(clone`DELETE FROM project_goal_mutation_state
    WHERE project_id = ${project}`).rejects.toMatchObject({ code: "23514" });
  await expect(clone`UPDATE organization_mutation_receipts SET command_fingerprint = ${"b".repeat(64)}
    WHERE org_id = ${org}`).rejects.toMatchObject({ code: "23514" });
  await expect(clone`DELETE FROM organization_mutation_receipts
    WHERE org_id = ${org}`).rejects.toMatchObject({ code: "23514" });
  await expect(clone`TRUNCATE organization_mutation_receipts`).rejects.toMatchObject({ code: "23514" });
  // This insert isolates the CHECK guard from the receipt update trigger.
  const invalidAudit = randomUUID();
  await clone`INSERT INTO activity_log (id, org_id, actor_id, action, entity_type, entity_id)
    VALUES (${invalidAudit}, ${org}, 'synthetic-board', 'project.created', 'project', ${fresh})`;
  await expect(clone`INSERT INTO organization_mutation_receipts
    (org_id, idempotency_key, command_kind, command_fingerprint, outcome,
     resulting_version, fence_epoch, activity_id, result)
    VALUES (${org}, 'bad-kind', 'invalid_kind', ${"a".repeat(64)}, 'applied', 1, 0, ${invalidAudit},
      ${clone.json({ organization_id: org, version: 1, fence_epoch: 0 })})`)
    .rejects.toMatchObject({ code: "23514" });
  expect(await clone`SELECT * FROM backup_check_fixture`).toEqual([{ id: -1 }]);
  expect(await clone`SELECT convalidated FROM pg_constraint WHERE conname = 'positive_id'`)
    .toEqual([{ convalidated: false }]);
  await expect(clone`INSERT INTO backup_check_fixture VALUES (-2)`).rejects.toMatchObject({ code: "23514" });
  expect(await clone`SELECT * FROM backup_trigger_events`).toEqual([{ id: 1 }]);
  expect(await clone`SELECT tgenabled FROM pg_trigger WHERE tgname = 'backup_always'`)
    .toEqual([{ tgenabled: "A" }]);
  await clone`INSERT INTO backup_trigger_fixture VALUES (2)`;
  expect(await clone`SELECT * FROM backup_trigger_events ORDER BY id`).toEqual([{ id: 1 }, { id: 2 }]);
  expect(await clone`SELECT * FROM project_goal_mutation_state WHERE project_id = ${project}`).toEqual(originalFence);
  expect(await clone`SELECT idempotency_key FROM organization_mutation_receipts WHERE org_id = ${org}`)
    .toEqual([{ idempotency_key: "backup-create" }]);
}, 120_000);
