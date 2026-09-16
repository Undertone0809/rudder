import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "../client.js";
import { createLocalPostgresInstance } from "../local-postgres-provider.js";

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("test port allocation failed"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

describe("D1 durable organization mutation ledger", () => {
  let db: postgres.Sql;
  let root: string;
  let instance: Awaited<ReturnType<typeof createLocalPostgresInstance>>["instance"];
  let started = false;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-d1-ledger-"));
    const port = await availablePort();
    ({ instance } = await createLocalPostgresInstance({
      databaseDir: path.join(root, "postgres"),
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    }));
    await instance.initialise();
    await instance.start();
    started = true;
    // Never use DATABASE_URL, an existing profile, or a production database.
    const url = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(url);
    db = postgres(url, { max: 4, onnotice: () => {} });
  }, 180_000);

  afterAll(async () => {
    try {
      if (db) await db.end({ timeout: 5 });
    } finally {
      try {
        if (started) await instance.stop();
      } finally {
        if (root) fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);

  async function organization(): Promise<string> {
    const id = randomUUID();
    await db`
      INSERT INTO organizations (id, url_key, name, issue_prefix)
      VALUES (${id}, ${`d1-${id}`}, 'D1 fixture', ${`D${id.replaceAll("-", "")}`})
    `;
    await db`INSERT INTO organization_mutation_authorities (org_id) VALUES (${id})`;
    return id;
  }

  async function activity(orgId: string, key: string): Promise<string> {
    const id = randomUUID();
    await db`
      INSERT INTO activity_log
        (id, org_id, actor_type, actor_id, action, entity_type, entity_id, idempotency_key)
      VALUES (${id}, ${orgId}, 'user', 'd1-fixture', 'organization.updated',
        'organization', ${orgId}, ${`d1:${key}`})
    `;
    return id;
  }

  async function receipt(orgId: string, key: string, activityId: string) {
    return await db`
      INSERT INTO organization_mutation_receipts
        (org_id, idempotency_key, command_kind, command_fingerprint,
         expected_version, resulting_version, fence_epoch, resulting_fence_epoch,
         outcome_kind, result, activity_id)
      VALUES (${orgId}, ${key}, 'organization_branding', ${"a".repeat(64)},
        0, 1, 1, 1, 'applied', '{"schemaVersion":1}'::jsonb, ${activityId})
    `;
  }

  it("does not transfer authority merely by installing the schema", async () => {
    const orgId = await organization();
    const [row] = await db`
      SELECT writer_owner, mutation_version::text AS version, fence_epoch::text AS fence
      FROM organization_mutation_authorities WHERE org_id = ${orgId}
    `;
    expect(row).toMatchObject({ writer_owner: "node", version: "0", fence: "0" });
    const [counts] = await db`
      SELECT count(*)::int AS count FROM organization_mutation_receipts WHERE org_id = ${orgId}
    `;
    expect(counts.count).toBe(0);
  });

  it("requires a new fence on ownership changes and rejects decreasing counters", async () => {
    const orgId = await organization();
    await expect(db`
      UPDATE organization_mutation_authorities SET writer_owner = 'rust_d1' WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "23514" });
    await db`
      UPDATE organization_mutation_authorities
      SET writer_owner = 'rust_d1', fence_epoch = 1, mutation_version = 2 WHERE org_id = ${orgId}
    `;
    await expect(db`
      UPDATE organization_mutation_authorities SET mutation_version = 1 WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "23514" });
    await expect(db`
      UPDATE organization_mutation_authorities SET fence_epoch = 0 WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("scopes idempotency keys to the organization and preserves the first result", async () => {
    const first = await organization();
    const second = await organization();
    const firstActivity = await activity(first, "same-key");
    await receipt(first, "same-key", firstActivity);
    await expect(receipt(first, "same-key", firstActivity)).rejects.toMatchObject({ code: "23505" });
    await receipt(second, "same-key", await activity(second, "same-key"));
    const rows = await db`
      SELECT org_id FROM organization_mutation_receipts
      WHERE org_id IN (${first}, ${second}) AND idempotency_key = 'same-key'
    `;
    expect(rows).toHaveLength(2);
  });

  it("cannot bind a receipt to another organization's activity or a missing activity", async () => {
    const first = await organization();
    const second = await organization();
    await expect(receipt(first, "foreign", await activity(second, "foreign")))
      .rejects.toMatchObject({ code: "23503" });
    await expect(receipt(first, "missing", randomUUID())).rejects.toMatchObject({ code: "23503" });
    const [row] = await db`SELECT count(*)::int AS count FROM organization_mutation_receipts WHERE org_id = ${first}`;
    expect(row.count).toBe(0);
  });

  it("rejects malformed identities and negative or unrepresentable authority counters", async () => {
    const orgId = await organization();
    await expect(db`
      UPDATE organization_mutation_authorities SET mutation_version = -1 WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "23514" });
    await expect(db`
      UPDATE organization_mutation_authorities SET fence_epoch = -1 WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "23514" });
    await expect(db`
      UPDATE organization_mutation_authorities SET mutation_version = '9223372036854775808' WHERE org_id = ${orgId}
    `).rejects.toMatchObject({ code: "22003" });
    await expect(db`
      INSERT INTO organization_mutation_receipts
        (org_id, idempotency_key, command_kind, command_fingerprint,
         expected_version, resulting_version, fence_epoch, resulting_fence_epoch,
         outcome_kind, result, activity_id)
      VALUES (${orgId}, '', 'organization_branding', 'not-a-fingerprint',
        0, 1, 1, 1, 'applied', '{}'::jsonb, ${await activity(orgId, "invalid")})
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back the domain write, version, activity, and receipt together", async () => {
    const orgId = await organization();
    const activityId = randomUUID();
    await expect(db.begin(async (tx) => {
      await tx`UPDATE organizations SET name = 'Must roll back' WHERE id = ${orgId}`;
      await tx`UPDATE organization_mutation_authorities SET mutation_version = 1 WHERE org_id = ${orgId}`;
      await tx`
        INSERT INTO activity_log (id, org_id, actor_type, actor_id, action, entity_type, entity_id)
        VALUES (${activityId}, ${orgId}, 'user', 'd1-fixture', 'organization.updated', 'organization', ${orgId})
      `;
      await tx`
        INSERT INTO organization_mutation_receipts
          (org_id, idempotency_key, command_kind, command_fingerprint,
           expected_version, resulting_version, fence_epoch, resulting_fence_epoch,
           outcome_kind, result, activity_id)
        VALUES (${orgId}, 'rollback', 'organization_branding', ${"b".repeat(64)},
          0, 1, 0, 0, 'applied', '{}'::jsonb, ${activityId})
      `;
      throw new Error("injected transaction failure");
    })).rejects.toThrow("injected transaction failure");
    const [row] = await db`
      SELECT o.name, a.mutation_version::text AS version,
        (SELECT count(*)::int FROM activity_log WHERE org_id = ${orgId}) AS activities,
        (SELECT count(*)::int FROM organization_mutation_receipts WHERE org_id = ${orgId}) AS receipts
      FROM organizations o JOIN organization_mutation_authorities a ON a.org_id = o.id
      WHERE o.id = ${orgId}
    `;
    expect(row).toMatchObject({ name: "D1 fixture", version: "0", activities: 0, receipts: 0 });
  });

  it("keeps committed receipts immutable", async () => {
    const orgId = await organization();
    await receipt(orgId, "immutable", await activity(orgId, "immutable"));
    await expect(db`
      UPDATE organization_mutation_receipts SET result = '{"rewritten":true}'::jsonb
      WHERE org_id = ${orgId} AND idempotency_key = 'immutable'
    `).rejects.toMatchObject({ code: "23514" });
    const [row] = await db`SELECT result FROM organization_mutation_receipts WHERE org_id = ${orgId}`;
    expect(row.result).toEqual({ schemaVersion: 1 });
  });

  it("preserves the old activity-first organization deletion order and other organizations", async () => {
    const removed = await organization();
    const retained = await organization();
    await receipt(removed, "delete", await activity(removed, "delete"));
    await receipt(retained, "keep", await activity(retained, "keep"));
    await db.begin(async (tx) => {
      await tx`DELETE FROM activity_log WHERE org_id = ${removed}`;
      await tx`DELETE FROM organizations WHERE id = ${removed}`;
    });
    expect(await db`SELECT org_id FROM organization_mutation_authorities WHERE org_id = ${removed}`).toHaveLength(0);
    expect(await db`SELECT org_id FROM organization_mutation_receipts WHERE org_id = ${removed}`).toHaveLength(0);
    expect(await db`SELECT org_id FROM organization_mutation_receipts WHERE org_id = ${retained}`).toHaveLength(1);
    // Old Node-shaped reads and writes still work without knowing the new tables.
    await db`UPDATE organizations SET name = 'Old writer still compatible' WHERE id = ${retained}`;
    const [row] = await db`SELECT name FROM organizations WHERE id = ${retained}`;
    expect(row.name).toBe("Old writer still compatible");
  });
});
