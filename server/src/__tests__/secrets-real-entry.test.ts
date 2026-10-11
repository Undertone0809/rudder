import {
  activityLog, applyPendingMigrations, authUsers, boardApiKeys, createDb, ensurePostgresDatabase,
  organizationMemberships, organizations,
} from "@rudderhq/db";
import { sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import { secretService } from "../services/secrets.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags: string[]; postgresFlags?: string[]; onLog: () => void; onError: () => void;
}) => EmbeddedPostgresInstance;

async function port() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function close(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe("Secrets public routes through Rust, PostgreSQL and the Board auth boundary", () => {
  let db: ReturnType<typeof createDb>;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let unavailableServer: Server | undefined;
  let preflightServer: Server | undefined;
  let databaseUrl = "";
  let fixtureBinary = "";
  let previousMasterKey: string | undefined;
  let previousMasterKeyFile: string | undefined;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const ownerId = `secrets-owner-${randomUUID()}`;
  const foreignId = `secrets-foreign-${randomUUID()}`;
  const ownerToken = `secrets-board-${randomUUID()}`;
  const foreignToken = `secrets-board-${randomUUID()}`;

  function get(url: string, token = ownerToken) {
    return request(server!).get(url).set("authorization", `Bearer ${token}`);
  }

  async function snapshot() {
    const rows: Record<string, string> = {};
    for (const table of ["organization_secrets", "organization_secret_versions", "activity_log", "organization_mutation_outbox"]) {
      const result = await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb)::text AS value FROM "${table}" x`));
      rows[table] = String(result[0]?.value ?? "[]");
    }
    return rows;
  }

  async function installAuditFailure(action: string) {
    await db.execute(sql.raw("CREATE OR REPLACE FUNCTION fail_secret_test_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = TG_ARGV[0] THEN RAISE EXCEPTION 'synthetic rollback fixture' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$"));
    await db.execute(sql.raw(`CREATE TRIGGER fail_secret_test_activity BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_secret_test_activity('${action}')`));
  }

  async function removeAuditFailure() {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS fail_secret_test_activity ON activity_log"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS fail_secret_test_activity()"));
  }

  async function installOutboxFailure() {
    await db.execute(sql.raw("CREATE OR REPLACE FUNCTION fail_secret_test_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox rollback fixture' USING ERRCODE='P0001'; END $$"));
    await db.execute(sql.raw("CREATE TRIGGER fail_secret_test_outbox BEFORE INSERT ON organization_mutation_outbox FOR EACH ROW EXECUTE FUNCTION fail_secret_test_outbox()"));
  }

  async function removeOutboxFailure() {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS fail_secret_test_outbox ON organization_mutation_outbox"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS fail_secret_test_outbox()"));
  }

  beforeAll(async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const targetDir = path.resolve(repo, process.env.CARGO_TARGET_DIR ?? "native/target");
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicit = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicit ? [path.resolve(repo, explicit)] : [
      path.join(targetDir, "debug", binaryName), path.join(targetDir, "release", binaryName),
    ];
    const binary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-secrets-public-http-"));
    previousMasterKey = process.env.RUDDER_SECRETS_MASTER_KEY;
    previousMasterKeyFile = process.env.RUDDER_SECRETS_MASTER_KEY_FILE;
    delete process.env.RUDDER_SECRETS_MASTER_KEY;
    const masterKeyFile = path.join(dataDir, "synthetic-secrets-master.key");
    fs.writeFileSync(masterKeyFile, "synthetic-secrets-key-0123456789", { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(masterKeyFile, 0o600);
    process.env.RUDDER_SECRETS_MASTER_KEY_FILE = masterKeyFile;

    const dbPort = await port();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({ databaseDir: path.join(dataDir, "postgres"), user: "rudder", password: "rudder", port: dbPort,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-c", "unix_socket_directories=", "-c", "dynamic_shared_memory_type=mmap"],
      onLog: () => {}, onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${dbPort}/postgres`, "rudder");
    databaseUrl = `postgres://rudder:rudder@127.0.0.1:${dbPort}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);

    const now = new Date();
    await db.insert(organizations).values([
      { id: orgId, name: "Secrets test", urlKey: `secrets-${orgId.slice(0, 8)}`, issuePrefix: `S${orgId.slice(0, 2).toUpperCase()}` },
      { id: foreignOrgId, name: "Foreign secrets", urlKey: `foreign-secrets-${foreignOrgId.slice(0, 8)}`, issuePrefix: `F${foreignOrgId.slice(0, 2).toUpperCase()}` },
    ]);
    await db.insert(authUsers).values([
      { id: ownerId, name: "Secrets owner", email: `${ownerId}@example.test`, createdAt: now, updatedAt: now },
      { id: foreignId, name: "Foreign board", email: `${foreignId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(organizationMemberships).values([
      { orgId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "admin" },
      { orgId: foreignOrgId, principalType: "user", principalId: foreignId, status: "active", membershipRole: "admin" },
    ]);
    await db.insert(boardApiKeys).values([
      { userId: ownerId, name: "Secrets owner", keyHash: createHash("sha256").update(ownerToken).digest("hex") },
      { userId: foreignId, name: "Foreign board", keyHash: createHash("sha256").update(foreignToken).digest("hex") },
    ]);

    fixtureBinary = path.join(dataDir, binaryName);
    fs.copyFileSync(binary, fixtureBinary, fs.constants.COPYFILE_FICLONE);
    bridge = createRustFoundationBridge({
      databaseUrl, binaryPath: fixtureBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000,
    });
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", secretRoutes(db, bridge));
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    await bridge.start();

    const unavailableApp = express();
    unavailableApp.use(express.json());
    unavailableApp.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    const missingBinaryBridge = createRustFoundationBridge({
      databaseUrl, binaryPath: path.join(dataDir, "missing-rudder-server-foundation"),
      mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 1_000,
    });
    unavailableApp.use("/api", secretRoutes(db, missingBinaryBridge));
    unavailableApp.use(errorHandler);
    unavailableServer = unavailableApp.listen(0, "127.0.0.1");
    await once(unavailableServer, "listening");

    const preflightApp = express();
    preflightApp.use(express.json());
    preflightApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board", userId: ownerId, orgIds: [orgId], isInstanceAdmin: false,
        source: "board_key", sessionId: "synthetic-preflight-session", authEpoch: 1,
      };
      next();
    });
    preflightApp.use("/api", secretRoutes(db, bridge));
    preflightApp.use(errorHandler);
    preflightServer = preflightApp.listen(0, "127.0.0.1");
    await once(preflightServer, "listening");
  }, 120_000);

  afterAll(async () => {
    try {
      await close(unavailableServer);
      await close(preflightServer);
      await close(server);
      await bridge?.close();
      await db?.$client.end({ timeout: 5 });
      await database?.stop();
    } finally {
      if (previousMasterKey === undefined) delete process.env.RUDDER_SECRETS_MASTER_KEY;
      else process.env.RUDDER_SECRETS_MASTER_KEY = previousMasterKey;
      if (previousMasterKeyFile === undefined) delete process.env.RUDDER_SECRETS_MASTER_KEY_FILE;
      else process.env.RUDDER_SECRETS_MASTER_KEY_FILE = previousMasterKeyFile;
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("serves all six routes, preserves encryption, Board/org authorization, and persistent restart behavior", async () => {
    const providers = await get(`/api/orgs/${orgId}/secret-providers`);
    expect(providers.status).toBe(200);
    expect(providers.body).toEqual([
      { id: "local_encrypted", label: "Local encrypted (default)", requiresExternalRef: false },
      { id: "aws_secrets_manager", label: "AWS Secrets Manager", requiresExternalRef: true },
      { id: "gcp_secret_manager", label: "GCP Secret Manager", requiresExternalRef: true },
      { id: "vault", label: "HashiCorp Vault", requiresExternalRef: true },
    ]);
    expect((await get(`/api/orgs/${orgId}/secrets`)).body).toEqual([]);
    expect((await get(`/api/orgs/${foreignOrgId}/secrets`)).status).toBe(403);
    expect((await get(`/api/orgs/${foreignOrgId}/secrets`, foreignToken)).status).toBe(200);

    const forgedOrg = await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "forged-org-secret", provider: "local_encrypted", value: "synthetic-forged-org-value", orgId: foreignOrgId,
    });
    expect(forgedOrg.status, forgedOrg.text).toBe(400);
    expect((await get(`/api/orgs/${foreignOrgId}/secrets`, foreignToken)).body).toEqual([]);

    const foreignSecret = await request(server!).post(`/api/orgs/${foreignOrgId}/secrets`).set("authorization", `Bearer ${foreignToken}`).send({
      name: "foreign-owned-secret", value: "synthetic-foreign-value",
    });
    expect(foreignSecret.status, foreignSecret.text).toBe(201);
    const crossOrgMutations = await Promise.all([
      request(server!).post(`/api/secrets/${foreignSecret.body.id}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-cross-org-rotate" }),
      request(server!).patch(`/api/secrets/${foreignSecret.body.id}`).set("authorization", `Bearer ${ownerToken}`).send({ name: "forged-foreign-rename" }),
      request(server!).delete(`/api/secrets/${foreignSecret.body.id}`).set("authorization", `Bearer ${ownerToken}`),
    ]);
    expect(crossOrgMutations.map((response) => response.status)).toEqual([403, 403, 403]);
    const foreignList = await get(`/api/orgs/${foreignOrgId}/secrets`, foreignToken);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body).toHaveLength(1);
    expect(foreignList.body[0]).toMatchObject({ id: foreignSecret.body.id, name: "foreign-owned-secret", latestVersion: 1 });
    expect(await secretService(db).resolveSecretValue(foreignOrgId, foreignSecret.body.id, "latest")).toBe("synthetic-foreign-value");
    expect((await request(server!).delete(`/api/secrets/${foreignSecret.body.id}`).set("authorization", `Bearer ${foreignToken}`)).status).toBe(200);

    const created = await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "integration-secret", provider: "local_encrypted", value: "synthetic-secret-value",
      description: "synthetic description", externalRef: "discarded-by-local-provider",
    });
    expect(created.status, created.text).toBe(201);
    expect(created.body).toMatchObject({ orgId, name: "integration-secret", provider: "local_encrypted", latestVersion: 1, description: "synthetic description", externalRef: null, createdByUserId: ownerId });
    expect(JSON.stringify(created.body)).not.toContain("synthetic-secret-value");
    expect(await secretService(db).resolveSecretValue(orgId, created.body.id, "latest")).toBe("synthetic-secret-value");

    expect((await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "integration-secret", value: "synthetic-duplicate",
    })).status).toBe(409);
    expect((await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "unsupported-provider", provider: "vault", value: "synthetic-provider-value",
    })).status).toBe(422);
    expect((await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "invalid-body", value: "synthetic", purpose: "managed_mcp_connection",
    })).status).toBe(400);

    const missingId = randomUUID();
    expect((await request(server!).post(`/api/secrets/${missingId}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-valid-body" })).status).toBe(404);
    expect((await request(server!).post(`/api/secrets/${missingId}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({})).status).toBe(400);
    expect((await request(server!).patch(`/api/secrets/${missingId}`).set("authorization", `Bearer ${ownerToken}`).send({})).status).toBe(404);
    expect((await request(server!).delete(`/api/secrets/${missingId}`).set("authorization", `Bearer ${ownerToken}`)).status).toBe(404);

    const rotateResponses = await Promise.all([
      request(server!).post(`/api/secrets/${created.body.id}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-rotate-one" }),
      request(server!).post(`/api/secrets/${created.body.id}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-rotate-two" }),
    ]);
    expect(rotateResponses.map((response) => response.status)).toEqual([200, 200]);
    const [rotated] = await db.execute(sql`SELECT latest_version FROM organization_secrets WHERE id=${created.body.id}::uuid`);
    expect(rotated?.latest_version).toBe(3);
    expect(await secretService(db).resolveSecretValue(orgId, created.body.id, "latest")).toMatch(/^synthetic-rotate-(one|two)$/);

    const updated = await request(server!).patch(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "integration-secret-renamed", description: null, externalRef: "synthetic-ref",
    });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.body).toMatchObject({ name: "integration-secret-renamed", description: null, externalRef: "synthetic-ref", latestVersion: 3 });
    const listed = await get(`/api/orgs/${orgId}/secrets`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("synthetic-rotate-");

    const createAudit = await db.select().from(activityLog).where(sql`${activityLog.action} = 'secret.created' AND ${activityLog.orgId} = ${orgId}`);
    expect(createAudit).toHaveLength(1);
    const restartSnapshot = await snapshot();
    await bridge!.close();
    const afterRestart = await get(`/api/orgs/${orgId}/secrets`);
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body[0]).toMatchObject({ id: created.body.id, name: "integration-secret-renamed", latestVersion: 3 });
    expect(await snapshot()).toEqual(restartSnapshot);

    const deleted = await request(server!).delete(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`);
    expect(deleted.status, deleted.text).toBe(200);
    expect(deleted.body).toEqual({ ok: true });
    expect((await get(`/api/orgs/${orgId}/secrets`)).body).toEqual([]);
  }, 60_000);

  it("returns 503 when native Secrets cannot start", async () => {
    const response = await request(unavailableServer!).get(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("rust_foundation_secrets_unavailable");
  }, 30_000);

  it("returns 503 across auth, native reads/writes, and all three Node mutation prechecks during a database outage, then recovers", async () => {
    const created = await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "database-outage-target", value: "synthetic-outage-value",
    });
    expect(created.status, created.text).toBe(201);

    await database!.stop();
    try {
      // The production actor middleware reads the Board identity from this database.
      expect((await get(`/api/orgs/${orgId}/secrets`)).status).toBe(503);

      const list = await request(preflightServer!).get(`/api/orgs/${orgId}/secrets`);
      expect(list.status).toBe(503);
      const create = await request(preflightServer!).post(`/api/orgs/${orgId}/secrets`).send({
        name: "database-outage-create", value: "synthetic-no-write",
      });
      expect(create.status).toBe(503);

      const rotate = await request(preflightServer!).post(`/api/secrets/${created.body.id}/rotate`).send({ value: "synthetic-no-rotate" });
      const update = await request(preflightServer!).patch(`/api/secrets/${created.body.id}`).send({ name: "synthetic-no-update" });
      const remove = await request(preflightServer!).delete(`/api/secrets/${created.body.id}`);
      expect([list.status, create.status, rotate.status, update.status, remove.status]).toEqual([503, 503, 503, 503, 503]);
      expect(list.body.error).toBe("Rust Secrets is unavailable");
      expect(create.body.error).toBe("Rust Secrets is unavailable");
      expect([rotate.status, update.status, remove.status]).toEqual([503, 503, 503]);
      for (const response of [rotate, update, remove]) {
        expect(response.body.code).toBe("database_unavailable");
      }
    } finally {
      await database!.start();
      await bridge!.close();
      await bridge!.start();
    }

    const recovered = await get(`/api/orgs/${orgId}/secrets`);
    expect(recovered.status, recovered.text).toBe(200);
    expect(recovered.body).toHaveLength(1);
    expect(recovered.body[0]).toMatchObject({ id: created.body.id, name: "database-outage-target", latestVersion: 1 });
    expect(await secretService(db).resolveSecretValue(orgId, created.body.id, "latest")).toBe("synthetic-outage-value");
    const removed = await request(server!).delete(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`);
    expect(removed.status).toBe(200);
  }, 60_000);

  it("rolls back each of the four mutation classes across the full table state when the same-tx audit fails", async () => {
    const created = await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "rollback-target", value: "synthetic-rollback-value",
    });
    expect(created.status, created.text).toBe(201);

    const failures = [
      {
        action: "secret.created",
        request: () => request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({ name: "rollback-create", value: "synthetic-create-failure" }),
      },
      {
        action: "secret.rotated",
        request: () => request(server!).post(`/api/secrets/${created.body.id}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-rotate-failure" }),
      },
      {
        action: "secret.updated",
        request: () => request(server!).patch(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`).send({ name: "rollback-renamed", description: "synthetic failed description" }),
      },
      {
        action: "secret.deleted",
        request: () => request(server!).delete(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`),
      },
    ];

    for (const failure of failures) {
      const before = await snapshot();
      await installAuditFailure(failure.action);
      try {
        const response = await failure.request();
        expect(response.status, `${failure.action}: ${response.text}`).toBe(500);
      } finally {
        await removeAuditFailure();
      }
      expect(await snapshot(), `${failure.action} must roll back secret, version, activity, and outbox rows`).toEqual(before);
    }
  }, 60_000);

  it("rolls back each mutation class across all four tables when the transactional outbox insert fails", async () => {
    const created = await request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "outbox-rollback-target", value: "synthetic-outbox-target-value",
    });
    expect(created.status, created.text).toBe(201);

    const failures = [
      {
        action: "create",
        request: () => request(server!).post(`/api/orgs/${orgId}/secrets`).set("authorization", `Bearer ${ownerToken}`).send({ name: "outbox-rollback-create", value: "synthetic-outbox-create-failure" }),
      },
      {
        action: "rotate",
        request: () => request(server!).post(`/api/secrets/${created.body.id}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ value: "synthetic-outbox-rotate-failure" }),
      },
      {
        action: "update",
        request: () => request(server!).patch(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`).send({ name: "outbox-rollback-renamed", description: "synthetic outbox update failure" }),
      },
      {
        action: "delete",
        request: () => request(server!).delete(`/api/secrets/${created.body.id}`).set("authorization", `Bearer ${ownerToken}`),
      },
    ];

    for (const failure of failures) {
      const before = await snapshot();
      await installOutboxFailure();
      try {
        const response = await failure.request();
        expect(response.status, `${failure.action}: ${response.text}`).toBe(500);
      } finally {
        await removeOutboxFailure();
      }
      expect(await snapshot(), `${failure.action} must roll back secret, version, activity, and outbox rows`).toEqual(before);
    }
  }, 60_000);
});
