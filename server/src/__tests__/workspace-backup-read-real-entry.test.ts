import {
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
  organizationMemberships,
  organizations,
  workspaceBackups,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { organizationRoutes } from "../routes/orgs.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

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
  initdbFlags: string[];
  postgresFlags?: string[];
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

import { createWorkspaceBackupV2 } from "../services/workspace-backup-v2.js";
import { workspaceBackupService } from "../services/workspace-backups.js";

describe("backup artifact reads through authenticated public HTTP, Rust and PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let artifacts = "";
  let isolatedBinary = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const userId = `backup-read-user-${randomUUID()}`;
  const token = `synthetic-backup-read-key-${randomUUID()}`;
  const ids = { v1: randomUUID(), v2: randomUUID(), foreign: randomUUID(), deleted: randomUUID(),
    running: randomUUID(), failed: randomUUID(), missing: randomUUID(), corrupt: randomUUID(),
    corruptV2: randomUUID(), wrongOrgV2: randomUUID(), caseSensitive: randomUUID(), max: randomUUID() };
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const contents = new Map<string, Buffer>([
    ["A.txt", Buffer.from("native backup read\n")], ["notes/中文.md", Buffer.from("Unicode ☃\n")],
    ["notes/large.txt", Buffer.from("x".repeat(210_000))], ["binary.bin", Buffer.from([0, 1, 255, 10])],
  ]);

  async function startPublicApp(selectedBridge?: RustFoundationBridge) {
    const app = express();
    app.get("/test-node-health", (_req, res) => res.json({ ok: true }));
    app.use(express.json());
    app.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api/orgs", organizationRoutes(db!, undefined, undefined, selectedBridge));
    app.use(errorHandler);
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    return listener;
  }
  function read(backupId: string, operation: string, inputPath = "", selectedOrg = orgId) {
    return request(server!).get(`/api/orgs/${selectedOrg}/workspace/backups/${backupId}/${operation}`)
      .query({ path: inputPath }).set("authorization", `Bearer ${token}`);
  }
  async function snapshot() {
    return db!.execute(sql`SELECT
      (SELECT md5(string_agg(to_jsonb(b)::text, '' ORDER BY id)) FROM workspace_backups b) AS backups,
      (SELECT count(*)::text FROM activity_log) AS activity,
      (SELECT count(*)::text FROM organization_mutation_outbox) AS outbox`);
  }

  beforeAll(async () => {
    // The differential oracle must exercise legacy Node parsing; the public
    // read routes remain unconditionally native even with pilot modes off.
    vi.stubEnv("RUDDER_NATIVE_MODE", "node");
    vi.stubEnv("RUDDER_WORKSPACE_BACKUP_V2_NATIVE", "false");
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const binary = process.env.RUDDER_SERVER_FOUNDATION_PATH ?? path.join(path.resolve(root, process.env.CARGO_TARGET_DIR ?? "native/target"), "debug", process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation");
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-backup-read-db-"));
    artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-backup-read-artifacts-"));
    isolatedBinary = path.join(artifacts, process.platform === "win32" ? "foundation-test.exe" : "foundation-test");
    fs.copyFileSync(binary, isolatedBinary);
    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({ databaseDir: dataDir, user: "rudder", password: "rudder", port,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: process.platform === "win32" ? [] : ["-k", ""], onLog: () => {}, onError: () => {} });
    await database.initialise(); await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    const url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.insert(organizations).values([
      { id: orgId, name: "Backup primary", urlKey: deriveOrganizationUrlKey(`Primary ${orgId}`), issuePrefix: "BRP" },
      { id: foreignOrgId, name: "Backup foreign", urlKey: deriveOrganizationUrlKey(`Foreign ${foreignOrgId}`), issuePrefix: "BRF" },
    ]);
    await db.insert(authUsers).values({ id: userId, name: "Synthetic backup reader", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(organizationMemberships).values({ orgId, principalType: "user", principalId: userId, status: "active" });
    await db.insert(boardApiKeys).values({ userId, name: "Synthetic backup test", keyHash: sha(Buffer.from(token)) });
    const source = path.join(artifacts, "Library");
    fs.mkdirSync(path.join(source, "notes"), { recursive: true });
    const createdAt = new Date("2025-01-02T03:04:06.000Z");
    const entries = [{ path: "notes", kind: "directory", mtimeMs: createdAt.getTime() },
      ...[...contents].map(([name, content]) => {
        fs.writeFileSync(path.join(source, name), content);
        fs.utimesSync(path.join(source, name), createdAt, createdAt);
        return { path: name, kind: "file", byteSize: content.byteLength, sha256: sha(content), dataBase64: content.toString("base64"), mtimeMs: createdAt.getTime() };
      })];
    const legacy = Buffer.from(JSON.stringify({ version: 1, orgId, instanceId: "synthetic", createdAt: createdAt.toISOString(), rootPath: source, entries, warnings: [] }));
    const v1Path = path.join(artifacts, "legacy.json"); fs.writeFileSync(v1Path, legacy);
    const v2 = await createWorkspaceBackupV2({ rootPath: source, orgId, instanceId: "synthetic", createdAt });
    const v2Path = path.join(artifacts, "current.zip"); fs.writeFileSync(v2Path, v2.archive);
    const caseBytes = Buffer.from(JSON.stringify({ version: 1, orgId, createdAt: createdAt.toISOString(), rootPath: source,
      entries: [
        { path: "A.txt", kind: "file", byteSize: 1, dataBase64: Buffer.from("A").toString("base64") },
        { path: "a.txt", kind: "file", byteSize: 1, dataBase64: Buffer.from("a").toString("base64") },
      ] }));
    const casePath = path.join(artifacts, "case-sensitive.json"); fs.writeFileSync(casePath, caseBytes);
    const foreignV2 = await createWorkspaceBackupV2({ rootPath: source, orgId: foreignOrgId, instanceId: "synthetic", createdAt });
    const foreignV2Path = path.join(artifacts, "foreign-identity.zip"); fs.writeFileSync(foreignV2Path, foreignV2.archive);
    await db.insert(workspaceBackups).values([
      { id: ids.caseSensitive, orgId, status: "succeeded", artifactRef: casePath, archiveSha256: sha(caseBytes) },
      { id: ids.corruptV2, orgId, status: "succeeded", artifactRef: v2Path, archiveSha256: "0".repeat(64) },
      { id: ids.wrongOrgV2, orgId, status: "succeeded", artifactRef: foreignV2Path, archiveSha256: sha(foreignV2.archive) },
      { id: ids.v1, orgId, status: "succeeded", artifactRef: v1Path, archiveSha256: sha(legacy) },
      { id: ids.v2, orgId, status: "succeeded", artifactRef: v2Path, archiveSha256: sha(v2.archive) },
      { id: ids.foreign, orgId: foreignOrgId, status: "succeeded", artifactRef: v1Path },
      { id: ids.deleted, orgId, status: "deleted", artifactRef: v1Path },
      { id: ids.running, orgId, status: "running", artifactRef: v1Path },
      { id: ids.failed, orgId, status: "failed", artifactRef: v1Path, error: "synthetic write failure" },
      { id: ids.missing, orgId, status: "succeeded", artifactRef: path.join(artifacts, "missing.json") },
      { id: ids.corrupt, orgId, status: "succeeded", artifactRef: v1Path, archiveSha256: "0".repeat(64) },
    ]);
    bridge = createRustFoundationBridge({ databaseUrl: url, binaryPath: isolatedBinary,
      mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off" });
    await bridge.start(); server = await startPublicApp(bridge);
  }, 60_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const cleanup of [() => closeServer(server), () => bridge?.close(),
      () => db?.$client.end({ timeout: 5 }), () => database?.stop()]) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    for (const dir of [dataDir, artifacts]) { if (dir) fs.rmSync(dir, { recursive: true, force: true }); }
    vi.unstubAllEnvs();
    if (errors.length) throw new AggregateError(errors, "Backup read fixture cleanup failed");
  }, 20_000);

  it.each(["v1", "v2"] as const)("preserves list, Unicode, binary and truncated preview contracts for %s without mutations", async (version) => {
    const before = await snapshot();
    const node = workspaceBackupService(db!);
    const id = ids[version];
    for (const directory of ["", "notes", " /notes/ ", "missing"]) {
      const actual = await read(id, "files", directory);
      expect(actual.status).toBe(200);
      expect(actual.body).toEqual(await node.listFiles(orgId, id, directory));
    }
    for (const filename of contents.keys()) {
      const actual = await read(id, "file", filename);
      expect(actual.status).toBe(200);
      expect(actual.body).toEqual(await node.readFile(orgId, id, filename));
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each(["v1", "v2"] as const)("streams the byte-identical %s archive and preserves content headers", async (version) => {
    const expected = await workspaceBackupService(db!).getDownload(orgId, ids[version]);
    const chunks: Buffer[] = [];
    if (expected.contentStream) { for await (const chunk of expected.contentStream) chunks.push(Buffer.from(chunk)); }
    const bytes = expected.content ?? Buffer.concat(chunks);
    const actual = await read(ids[version], "download").buffer(true).parse((response, callback) => {
      const buffers: Buffer[] = []; response.on("data", chunk => buffers.push(Buffer.from(chunk)));
      response.on("end", () => callback(null, Buffer.concat(buffers))); response.on("error", callback);
    });
    expect(actual.status).toBe(200);
    expect(actual.body).toEqual(bytes);
    expect(actual.headers["content-length"]).toBe(String(expected.byteSize));
    expect(actual.headers["content-type"]).toBe("application/zip");
    expect(actual.headers["x-rudder-archive-sha256"]).toBe(expected.archiveSha256);
    expect(actual.headers["content-disposition"]).toBe(`attachment; filename="${expected.filename}"`);
  });

  it("preserves errors and rejects foreign, deleted, missing and corrupt backups before sending archive bytes", async () => {
    for (const operation of ["files", "file", "download"] as const) {
      const method = operation === "files" ? "listFiles" : operation === "file" ? "readFile" : "getDownload";
      for (const id of [ids.foreign, ids.deleted, ids.running, ids.failed, ids.missing, ids.corrupt, ids.corruptV2, ids.wrongOrgV2, randomUUID()]) {
        const expected = await workspaceBackupService(db!)[method](orgId, id, "A.txt").then(() => null, error => error as { status: number; message: string });
        expect(expected).not.toBeNull();
        const actual = await read(id, operation, "A.txt");
        expect(actual.status).toBe(expected!.status);
        expect(actual.body).toEqual({ error: expected!.message });
        expect(actual.headers["content-disposition"]).toBeUndefined();
      }
    }
    for (const operation of ["files", "file", "download"]) {
      expect((await request(server!).get(`/api/orgs/${orgId}/workspace/backups/${ids.v1}/${operation}`)).status).toBe(401);
      expect((await read(ids.foreign, operation, "", foreignOrgId)).status).toBe(403);
    }
    for (const filename of ["A.txt", "unknown.txt"]) {
      const rejected = await read(ids.wrongOrgV2, "file", filename);
      expect(rejected.status).toBe(422);
      expect(rejected.body).toEqual({ error: "Workspace backup v2 artifact is invalid: organization identity mismatch" });
    }
    expect((await read(ids.v1, "files", "../escape")).status).toBe(422);
    expect((await read(ids.v1, "file", "unknown.txt")).status).toBe(404);
  });

  it("preserves PostgreSQL-compatible backup UUID spelling", async () => {
    for (const alias of [ids.v1.toUpperCase(), ids.v1.replaceAll("-", ""), `{${ids.v1}}`]) {
      const actual = await read(alias, "files");
      expect(actual.status).toBe(200);
      expect(actual.body).toEqual(await workspaceBackupService(db!).listFiles(orgId, alias));
    }
  });

  it("keeps distinct case-sensitive legacy names and their exact contents", async () => {
    const actual = await read(ids.caseSensitive, "files");
    expect(actual.status).toBe(200);
    expect(actual.body).toEqual(await workspaceBackupService(db!).listFiles(orgId, ids.caseSensitive));
    for (const filename of ["A.txt", "a.txt"]) {
      const detail = await read(ids.caseSensitive, "file", filename);
      expect(detail.status).toBe(200);
      expect(detail.body).toEqual(await workspaceBackupService(db!).readFile(orgId, ids.caseSensitive, filename));
    }
  });

  it("reads and streams the documented 100 MiB legacy backup beyond the old encoded envelope cap", async () => {
    const artifact = path.join(artifacts, "maximum.json");
    const encoded = Buffer.alloc(5 * 1024 * 1024, 120).toString("base64");
    fs.writeFileSync(artifact, JSON.stringify({ version: 1, orgId, rootPath: "/synthetic/Library", createdAt: "2025-01-02T03:04:06.000Z" }).slice(0, -1) + ',"entries":[');
    for (let index = 0; index < 20; index++) {
      fs.appendFileSync(artifact, (index ? "," : "") + JSON.stringify({ path: `file-${index}.txt`, kind: "file", byteSize: 5 * 1024 * 1024, dataBase64: encoded }));
    }
    fs.appendFileSync(artifact, "]}");
    expect(fs.statSync(artifact).size).toBeGreaterThan(116 * 1024 * 1024);
    await db!.insert(workspaceBackups).values({ id: ids.max, orgId, status: "succeeded", artifactRef: artifact });
    const listed = await read(ids.max, "files");
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toHaveLength(20);
    const preview = await read(ids.max, "file", "file-0.txt");
    expect(preview.status).toBe(200);
    expect(preview.body.content).toHaveLength(200_000);
    expect(preview.body.truncated).toBe(true);
    const downloaded = await read(ids.max, "download").buffer(true).parse((response, callback) => {
      const hash = createHash("sha256"); let total = 0; let tail = Buffer.alloc(0);
      response.on("data", (chunk: Buffer) => { hash.update(chunk); total += chunk.length; tail = Buffer.concat([tail, chunk]).subarray(-22); });
      response.on("end", () => callback(null, { total, hash: hash.digest("hex"), entries: tail.readUInt16LE(10) }));
      response.on("error", callback);
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.body.total).toBeGreaterThan(100 * 1024 * 1024);
    expect(downloaded.body.entries).toBe(21);
    expect(downloaded.headers["content-length"]).toBe(String(downloaded.body.total));
    expect(downloaded.headers["x-rudder-archive-sha256"]).toBe(downloaded.body.hash);
  }, 60_000);

  it("keeps Node responsive when the real native process and only its test binary are unavailable", async () => {
    const before = await snapshot();
    await bridge!.close();
    const unavailablePath = `${isolatedBinary}.unavailable`;
    fs.renameSync(isolatedBinary, unavailablePath);
    try {
      expect((await request(server!).get("/test-node-health")).status).toBe(200);
      for (const operation of ["files", "file", "download"]) {
        expect((await read(ids.v1, operation)).status).toBe(503);
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      fs.renameSync(unavailablePath, isolatedBinary);
      await bridge!.start();
    }
  });

  it("fails closed through the public route when the bridge is unavailable", async () => {
    const unavailable = await startPublicApp();
    try {
      for (const operation of ["files", "file", "download"]) {
        const actual = await request(unavailable).get(`/api/orgs/${orgId}/workspace/backups/${ids.v1}/${operation}`).set("authorization", `Bearer ${token}`);
        expect(actual.status).toBe(503);
      }
    } finally { await closeServer(unavailable); }
  });
});
