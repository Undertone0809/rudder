import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, ensurePostgresDatabase } from "../client.js";

const migrations = path.dirname(fileURLToPath(import.meta.url));
const originalOrg = randomUUID();
let root = "";
let instance: EmbeddedPostgres | undefined;
let db: postgres.Sql;

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("No disposable PostgreSQL port")));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function organization(): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES (${id}, ${id}, 'Synthetic D1 organization', ${id})`;
  return id;
}

async function activity(org: string): Promise<string> {
  const id = randomUUID();
  await db`INSERT INTO activity_log (id, org_id, actor_id, action, entity_type, entity_id)
    VALUES (${id}, ${org}, 'synthetic-board', 'organization.updated', 'organization', ${org})`;
  return id;
}

async function receipt(
  sql: postgres.Sql | postgres.TransactionSql,
  org: string,
  audit: string,
  key = "synthetic-command",
) {
  return sql.unsafe(
    `INSERT INTO organization_mutation_receipts
      (org_id, idempotency_key, command_kind, command_fingerprint, outcome,
       resulting_version, fence_epoch, activity_id, result)
      VALUES ($1, $2, 'organization_branding', $3, 'applied', 1, 0, $4, $5::jsonb)`,
    [
      org,
      key,
      "a".repeat(64),
      audit,
      JSON.stringify({ organization_id: org, version: 1, fence_epoch: 0 }),
    ],
  );
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "rudder-d1-schema-"));
  const port = await availablePort();
  instance = new EmbeddedPostgres({
    databaseDir: path.join(root, "postgres"),
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();
  const admin = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(admin, "rudder");
  const url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  db = postgres(url, { max: 3, onnotice: () => {} });

  const prior = path.join(root, "prior-migrations");
  mkdirSync(path.join(prior, "meta"), { recursive: true });
  const journal = JSON.parse(
    readFileSync(path.join(migrations, "meta/_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx <= 162,
  );
  for (const entry of journal.entries) {
    copyFileSync(
      path.join(migrations, `${entry.tag}.sql`),
      path.join(prior, `${entry.tag}.sql`),
    );
  }
  writeFileSync(
    path.join(prior, "meta/_journal.json"),
    JSON.stringify(journal),
  );
  await migrate(drizzle(db), { migrationsFolder: prior });
  await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES (${originalOrg}, ${originalOrg}, 'Before D1', ${originalOrg})`;
  await applyPendingMigrations(url);
  await applyPendingMigrations(url);
}, 120_000);

afterAll(async () => {
  await db?.end({ timeout: 5 });
  await instance?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("D1 durable mutation schema on real PostgreSQL", () => {
  it("backfills Node-owned baselines without activating Rust or changing old writes", async () => {
    expect(
      await db`SELECT name FROM organizations WHERE id = ${originalOrg}`,
    ).toMatchObject([{ name: "Before D1" }]);
    expect(
      await db`SELECT owner, mutation_version::text, fence_epoch::text
        FROM organization_mutation_state WHERE org_id = ${originalOrg}`,
    ).toEqual([{ owner: "node", mutation_version: "0", fence_epoch: "0" }]);
    await db`UPDATE organizations SET name = 'Node still writes' WHERE id = ${originalOrg}`;
    const org = await organization();
    const [row] =
      await db`SELECT owner, mutation_version::text, fence_epoch::text
      FROM organization_mutation_state WHERE org_id = ${org}`;
    expect(row).toEqual({
      owner: "node",
      mutation_version: "0",
      fence_epoch: "0",
    });
  });

  it("provisions the Node-owned baseline for a newly inserted organization", async () => {
    const id = randomUUID();
    await db`INSERT INTO organizations (id, url_key, name, issue_prefix)
      VALUES (${id}, ${id}, 'Trigger-provisioned organization', ${id})`;
    expect(
      await db`SELECT owner, mutation_version::text, fence_epoch::text
        FROM organization_mutation_state WHERE org_id = ${id}`,
    ).toEqual([{ owner: "node", mutation_version: "0", fence_epoch: "0" }]);
    const [state] = await db`SELECT fence_token::text
      FROM organization_mutation_state WHERE org_id = ${id}`;
    expect(state.fence_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("serializes a Node business transaction before a Rust ownership handoff", async () => {
    const org = await organization();
    let releaseNodeTransaction!: () => void;
    const nodeTransactionMayCommit = new Promise<void>((resolve) => {
      releaseNodeTransaction = resolve;
    });
    let nodeFenceLocked!: () => void;
    const nodeFenceIsLocked = new Promise<void>((resolve) => {
      nodeFenceLocked = resolve;
    });

    const nodeTransaction = db.begin(async (tx) => {
      await tx.unsafe(
        "SELECT org_id FROM organization_mutation_state WHERE org_id = $1 FOR UPDATE",
        [org],
      );
      nodeFenceLocked();
      await tx.unsafe(
        "UPDATE organizations SET name = 'Node transaction owns the fence' WHERE id = $1",
        [org],
      );
      await nodeTransactionMayCommit;
    });
    await nodeFenceIsLocked;

    await expect(
      db.begin(async (tx) => {
        await tx.unsafe("SET LOCAL lock_timeout = '50ms'");
        await tx.unsafe(
          "SELECT org_id FROM organization_mutation_state WHERE org_id = $1 FOR UPDATE",
          [org],
        );
      }),
    ).rejects.toMatchObject({ code: "55P03" });

    releaseNodeTransaction();
    await nodeTransaction;

    await db.begin(async (tx) => {
      await tx.unsafe(
        "UPDATE organization_mutation_state "
          + "SET owner = 'rust', fence_epoch = 1, fence_token = gen_random_uuid() "
          + "WHERE org_id = $1",
        [org],
      );
    });

    await expect(
      db.begin(async (tx) => {
        const [state] = await tx.unsafe<{ owner: string }[]>(
          "SELECT owner FROM organization_mutation_state WHERE org_id = $1 FOR UPDATE",
          [org],
        );
        if (state.owner !== "node") {
          throw new Error("Node authority is no longer owned by Node");
        }
        await tx.unsafe(
          "UPDATE organizations SET name = 'stale Node writer' WHERE id = $1",
          [org],
        );
      }),
    ).rejects.toThrow("Node authority is no longer owned by Node");
    expect(await db`SELECT name FROM organizations WHERE id = ${org}`).toEqual([
      { name: "Node transaction owns the fence" },
    ]);
  });

  it("does not grant Rust authority with an unfenced initial row", async () => {
    await expect(db`UPDATE organization_mutation_state
      SET owner = 'rust' WHERE org_id = ${originalOrg}`).rejects.toMatchObject({
      code: "23514",
    });
    expect(
      await db`SELECT owner, mutation_version::text, fence_epoch::text
        FROM organization_mutation_state WHERE org_id = ${originalOrg}`,
    ).toEqual([{ owner: "node", mutation_version: "0", fence_epoch: "0" }]);
  });

  it("requires the receipt activity to belong to the same organization", async () => {
    const own = await organization();
    const foreign = await organization();
    const audit = await activity(foreign);
    await expect(
      db.begin((tx) => receipt(tx, own, audit)),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      await db`SELECT * FROM organization_mutation_receipts WHERE org_id = ${own}`,
    ).toHaveLength(0);
  });

  it("scopes durable keys to organization and never overwrites a conflicting receipt", async () => {
    const own = await organization();
    await receipt(db, own, await activity(own));
    await expect(receipt(db, own, await activity(own))).rejects.toMatchObject({
      code: "23505",
    });
    const other = await organization();
    await receipt(db, other, await activity(other));
    expect(
      await db`SELECT * FROM organization_mutation_receipts WHERE org_id = ${own}`,
    ).toHaveLength(1);
  });

  it("preserves the old activity-first organization deletion transaction", async () => {
    const org = await organization();
    await receipt(db, org, await activity(org));
    await db.begin(async (tx) => {
      await tx.unsafe("DELETE FROM activity_log WHERE org_id = $1", [org]);
      await tx.unsafe("DELETE FROM organizations WHERE id = $1", [org]);
    });
    expect(
      await db`SELECT * FROM organization_mutation_receipts WHERE org_id = ${org}`,
    ).toHaveLength(0);
    expect(
      await db`SELECT * FROM organization_mutation_state WHERE org_id = ${org}`,
    ).toHaveLength(0);
  });

  it("cannot delete an activity while its live organization receipt survives", async () => {
    const org = await organization();
    const audit = await activity(org);
    await receipt(db, org, audit);
    await expect(
      db`DELETE FROM activity_log WHERE org_id = ${org} AND id = ${audit}`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects backwards versions and unfenced owner changes", async () => {
    const org = await organization();
    await db`UPDATE organization_mutation_state SET mutation_version = 2 WHERE org_id = ${org}`;
    await expect(
      db`UPDATE organization_mutation_state SET mutation_version = 1 WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`UPDATE organization_mutation_state SET owner = 'rust' WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await db`UPDATE organization_mutation_state
      SET owner = 'rust', fence_epoch = 1, fence_token = gen_random_uuid()
      WHERE org_id = ${org}`;
    await expect(
      db`UPDATE organization_mutation_state SET fence_epoch = 0 WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`UPDATE organization_mutation_state
        SET fence_epoch = 2
        WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`UPDATE organization_mutation_state
        SET fence_token = gen_random_uuid()
        WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps receipts immutable and prevents resetting live authority rows", async () => {
    const org = await organization();
    await receipt(db, org, await activity(org));
    await expect(
      db`UPDATE organization_mutation_receipts SET command_fingerprint = ${"b".repeat(64)} WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`DELETE FROM organization_mutation_state WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db`DELETE FROM organization_mutation_receipts WHERE org_id = ${org}`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("supports signed BIGINT bounds and rejects invalid receipt envelopes", async () => {
    const org = await organization();
    await db`UPDATE organization_mutation_state SET mutation_version = 9223372036854775807 WHERE org_id = ${org}`;
    const [state] =
      await db`SELECT mutation_version::text FROM organization_mutation_state WHERE org_id = ${org}`;
    expect(state.mutation_version).toBe("9223372036854775807");
    const audit = await activity(org);
    await expect(receipt(db, org, audit, "")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      receipt(db, org, audit, "x".repeat(257)),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(db`INSERT INTO organization_mutation_receipts
      (org_id, idempotency_key, command_kind, command_fingerprint, outcome, resulting_version, fence_epoch, activity_id, result)
      VALUES (${org}, 'bad-result', 'organization_branding', ${"a".repeat(64)}, 'applied', 1, 0, ${audit}, '{}'::jsonb)`).rejects.toMatchObject(
      { code: "23514" },
    );
  });

  it("rolls business and activity writes back when deferred receipt validation fails", async () => {
    const own = await organization();
    const foreign = await organization();
    const foreignAudit = await activity(foreign);
    const localAudit = randomUUID();
    await expect(
      db.begin(async (tx) => {
        await tx.unsafe(
          "UPDATE organizations SET name = 'Must roll back' WHERE id = $1",
          [own],
        );
        await tx.unsafe(
          `INSERT INTO activity_log (id, org_id, actor_id, action, entity_type, entity_id)
        VALUES ($1, $2::uuid, 'synthetic-board', 'organization.updated', 'organization', $2::text)`,
          [localAudit, own],
        );
        await receipt(tx, own, foreignAudit);
      }),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      await db`SELECT name FROM organizations WHERE id = ${own}`,
    ).toMatchObject([{ name: "Synthetic D1 organization" }]);
    expect(
      await db`SELECT id FROM activity_log WHERE org_id = ${own} AND id = ${localAudit}`,
    ).toHaveLength(0);
  });
});
