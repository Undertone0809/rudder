import {
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
  instanceUserRoles,
  organizationMemberships,
  organizations,
  workspaceBackups,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, type WorkspaceBackupSummary } from "@rudderhq/shared";
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
  onLog: () => void;
  onError: () => void;
}) => EmbeddedPostgresInstance;

type BackupFixtureInput = {
  id: string;
  orgId: string;
  status: WorkspaceBackupSummary["status"];
  createdAt: Date;
  createdByUserId: string | null;
  expiresAt?: Date | null;
  warning?: string;
};

function backupFixture(input: BackupFixtureInput) {
  const startedAt = new Date(input.createdAt.getTime() - 60_000);
  const finishedAt = new Date(input.createdAt.getTime() - 30_000);
  const fallbackExpiresAt = new Date(input.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const expiresAt = input.expiresAt === undefined ? fallbackExpiresAt : input.expiresAt;
  const values = {
    id: input.id,
    orgId: input.orgId,
    status: input.status,
    triggerSource: "manual" as const,
    artifactProvider: "local_file" as const,
    artifactRef: `test-only/${input.id}.json`,
    archiveSha256: "a".repeat(64),
    treeSha256: "b".repeat(64),
    fileCount: 2,
    byteSize: 128,
    compressedSize: 72,
    manifest: { version: 1, entries: [{ path: `sentinel/${input.id}`, kind: "file" }] },
    warnings: [input.warning ?? "fixture warning"],
    error: null,
    startedAt,
    finishedAt,
    expiresAt,
    restoredFromBackupId: null,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  } satisfies typeof workspaceBackups.$inferInsert;
  const summary: WorkspaceBackupSummary = {
    ...values,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    expiresAt: (expiresAt ?? fallbackExpiresAt).toISOString(),
    createdAt: input.createdAt.toISOString(),
    updatedAt: input.createdAt.toISOString(),
  };
  return { values, summary };
}

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

describe("workspace backup list through the real public Node route, Rust and PostgreSQL", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let connectionString = "";
  let nativeBinary = "";

  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const mediumOrgId = randomUUID();
  const largeOrgId = randomUUID();
  const dstOrgId = randomUUID();
  const unknownOrgId = randomUUID();
  const boardUserId = `workspace-backup-list-user-${randomUUID()}`;
  const boardToken = `workspace-backup-list-board-${randomUUID()}`;
  const scopedBoardUserId = `workspace-backup-list-scoped-user-${randomUUID()}`;
  const scopedBoardToken = `workspace-backup-list-scoped-board-${randomUUID()}`;
  const emptyOrgId = randomUUID();
  const olderBackupId = randomUUID();
  const newerBackupId = randomUUID();
  const deletedBackupId = randomUUID();
  const foreignBackupId = randomUUID();
  const dstBackupId = randomUUID();

  const older = backupFixture({
    id: olderBackupId,
    orgId,
    status: "succeeded",
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
    createdByUserId: boardUserId,
  });
  const newer = backupFixture({
    id: newerBackupId,
    orgId,
    status: "succeeded",
    createdAt: new Date("2025-01-02T10:00:00.000Z"),
    createdByUserId: boardUserId,
  });
  const deleted = backupFixture({
    id: deletedBackupId,
    orgId,
    status: "deleted",
    createdAt: new Date("2025-01-04T10:00:00.000Z"),
    createdByUserId: boardUserId,
  });
  const foreign = backupFixture({
    id: foreignBackupId,
    orgId: foreignOrgId,
    status: "succeeded",
    createdAt: new Date("2025-01-03T10:00:00.000Z"),
    createdByUserId: boardUserId,
  });
  const dst = backupFixture({
    id: dstBackupId,
    orgId: dstOrgId,
    status: "succeeded",
    createdAt: new Date("2025-03-01T05:00:00.000Z"),
    createdByUserId: boardUserId,
    expiresAt: null,
  });
  const mediumFixtures = Array.from({ length: 96 }, (_, index) => backupFixture({
    id: randomUUID(),
    orgId: mediumOrgId,
    status: index % 2 === 0 ? "succeeded" : "failed",
    createdAt: new Date(Date.UTC(2025, 1, 1) + index * 1_000),
    createdByUserId: boardUserId,
    warning: `medium-${index}-` + "m".repeat(3 * 1024),
  }));
  const largeFixtures = Array.from({ length: 1_350 }, (_, index) => backupFixture({
    id: randomUUID(),
    orgId: largeOrgId,
    status: index % 2 === 0 ? "succeeded" : "failed",
    createdAt: new Date(Date.UTC(2025, 2, 1) + index * 1_000),
    createdByUserId: boardUserId,
    warning: `large-${index}-` + "l".repeat(4 * 1024),
  }));

  async function startPublicApp(selectedBridge?: RustFoundationBridge) {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db!, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api/orgs", organizationRoutes(db!, undefined, undefined, selectedBridge));
    app.use(errorHandler);
    const listener = app.listen(0, "127.0.0.1");
    await once(listener, "listening");
    return listener;
  }

  function createBridge() {
    return createRustFoundationBridge({
      databaseUrl: connectionString,
      binaryPath: nativeBinary,
      mode: "off",
      organizationBrandingMode: "off",
      projectGoalSetMode: "off",
    });
  }

  async function backupTableSnapshot() {
    return await db!.transaction(async (tx) => {
      // The test changes the database default timezone for DST coverage. Pin
      // this session-local snapshot representation so pooled connections hash
      // identical timestamptz values identically.
      await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
      const rows = await tx.execute(sql`
        SELECT count(*)::text AS row_count,
               md5(coalesce(string_agg(to_jsonb(snapshot)::text, E'\\n' ORDER BY snapshot.id), '')) AS fingerprint
        FROM workspace_backups AS snapshot
      `);
      return rows[0];
    });
  }

  async function activityAndOutboxSnapshot(snapshotOrgId = orgId) {
    const rows = await db!.execute(sql`
      SELECT
        (SELECT count(*)::text
         FROM activity_log
         WHERE org_id = ${snapshotOrgId}::uuid) AS activity_log_count,
        (SELECT md5(coalesce(string_agg(to_jsonb(snapshot)::text, E'\\n' ORDER BY snapshot.id), ''))
         FROM activity_log AS snapshot
         WHERE snapshot.org_id = ${snapshotOrgId}::uuid) AS activity_log_fingerprint,
        (SELECT count(*)::text
         FROM organization_mutation_outbox
         WHERE org_id = ${snapshotOrgId}::uuid) AS outbox_count,
        (SELECT md5(coalesce(string_agg(to_jsonb(snapshot)::text, E'\\n' ORDER BY snapshot.id), ''))
         FROM organization_mutation_outbox AS snapshot
         WHERE snapshot.org_id = ${snapshotOrgId}::uuid) AS outbox_fingerprint
    `);
    const snapshot = rows[0];
    if (!snapshot) throw new Error("Failed to calculate privacy-safe activity and outbox snapshots");
    return snapshot;
  }

  beforeAll(async () => {
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const targetRoot = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary
      ? [explicitBinary]
      : [path.join(targetRoot, "debug", binaryName), path.join(targetRoot, "release", binaryName)];
    nativeBinary = candidates.find((candidate) => {
      try {
        fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? candidates[0]!;
    try {
      fs.accessSync(nativeBinary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      throw new Error(`Real workspace-backup list integration requires a built foundation binary at ${nativeBinary}. Run cargo build --locked --manifest-path native/Cargo.toml -p rudder-server-foundation --bin rudder-server-foundation, or set RUDDER_SERVER_FOUNDATION_PATH.`);
    }

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-workspace-backup-list-postgres-"));
    const port = await getAvailablePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {},
      onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.insert(organizations).values([
      { id: orgId, name: "Backup list primary", urlKey: deriveOrganizationUrlKey(`Backup list ${orgId}`), issuePrefix: "BLP" },
      { id: foreignOrgId, name: "Backup list foreign", urlKey: deriveOrganizationUrlKey(`Backup list ${foreignOrgId}`), issuePrefix: "BLF" },
      { id: mediumOrgId, name: "Backup list medium", urlKey: deriveOrganizationUrlKey(`Backup list ${mediumOrgId}`), issuePrefix: "BLM" },
      { id: largeOrgId, name: "Backup list large", urlKey: deriveOrganizationUrlKey(`Backup list ${largeOrgId}`), issuePrefix: "BLL" },
      { id: dstOrgId, name: "Backup list DST", urlKey: deriveOrganizationUrlKey(`Backup list ${dstOrgId}`), issuePrefix: "BLD" },
      { id: emptyOrgId, name: "Backup list empty", urlKey: deriveOrganizationUrlKey(`Backup list ${emptyOrgId}`), issuePrefix: "BLE" },
    ]);
    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    await db.insert(authUsers).values([
      {
        id: boardUserId,
        name: "Workspace backup list test",
        email: `${boardUserId}@example.test`,
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: scopedBoardUserId,
        name: "Workspace backup list scoped test",
        email: `${scopedBoardUserId}@example.test`,
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await db.insert(instanceUserRoles).values({ userId: boardUserId, role: "instance_admin" });
    await db.insert(organizationMemberships).values({
      orgId,
      principalType: "user",
      principalId: scopedBoardUserId,
      status: "active",
    });
    await db.insert(boardApiKeys).values([
      {
        userId: boardUserId,
        name: "Workspace backup list test",
        keyHash: createHash("sha256").update(boardToken).digest("hex"),
      },
      {
        userId: scopedBoardUserId,
        name: "Workspace backup list scoped test",
        keyHash: createHash("sha256").update(scopedBoardToken).digest("hex"),
      },
    ]);
    await db.insert(workspaceBackups).values([
      older.values,
      newer.values,
      deleted.values,
      foreign.values,
      dst.values,
      ...mediumFixtures.map((fixture) => fixture.values),
      ...largeFixtures.map((fixture) => fixture.values),
    ]);

    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'America/New_York'`);
    bridge = createBridge();
    await bridge.start();
    server = await startPublicApp(bridge);
  }, 60_000);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      await closeServer(server);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await bridge?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await db?.$client.end({ timeout: 5 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await database?.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to fully clean up workspace backup list test resources");
    }
  }, 20_000);

  it("authenticates Board list reads, returns only ordered live rows, maps a missing org, and leaves backups unchanged", async () => {
    const baseline = await backupTableSnapshot();
    const url = `/api/orgs/${orgId}/workspace/backups`;

    const unauthenticated = await request(server!).get(url);
    expect(unauthenticated.status).toBe(401);

    const beforePrimaryGet = await activityAndOutboxSnapshot();
    const primaryList = await request(server!)
      .get(url)
      .set("authorization", `Bearer ${boardToken}`);
    expect(primaryList.status).toBe(200);
    expect(primaryList.body).toEqual({ backups: [newer.summary, older.summary] });
    expect(primaryList.body.backups.map((backup: WorkspaceBackupSummary) => backup.id))
      .not.toContain(deletedBackupId);
    expect(primaryList.body.backups.map((backup: WorkspaceBackupSummary) => backup.id))
      .not.toContain(foreignBackupId);
    expect(await activityAndOutboxSnapshot()).toEqual(beforePrimaryGet);

    const beforeEmptyRead = await activityAndOutboxSnapshot(emptyOrgId);
    const emptyList = await request(server!)
      .get(`/api/orgs/${emptyOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(emptyList.status).toBe(200);
    expect(emptyList.body).toEqual({ backups: [] });
    expect(await activityAndOutboxSnapshot(emptyOrgId)).toEqual(beforeEmptyRead);

    const dstList = await request(server!)
      .get(`/api/orgs/${dstOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(dstList.status).toBe(200);
    expect(dstList.body).toEqual({ backups: [dst.summary] });
    expect(dstList.body.backups[0].expiresAt).toBe("2025-03-31T05:00:00.000Z");

    const beforeMediumGet = await activityAndOutboxSnapshot(mediumOrgId);
    const mediumList = await request(server!)
      .get(`/api/orgs/${mediumOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(mediumList.status).toBe(200);
    const mediumJsonBytes = Buffer.byteLength(JSON.stringify(mediumList.body));
    expect(mediumJsonBytes).toBeGreaterThan(256 * 1024);
    expect(mediumJsonBytes).toBeLessThan(4 * 1024 * 1024);
    const mediumExpected = [...mediumFixtures].reverse().map((fixture) => fixture.summary);
    expect(mediumList.body.backups).toHaveLength(mediumExpected.length);
    expect(mediumList.body.backups).toEqual(mediumExpected);
    expect(mediumList.body.backups.at(-1)).toEqual(mediumFixtures[0]!.summary);
    expect(await activityAndOutboxSnapshot(mediumOrgId)).toEqual(beforeMediumGet);

    const beforeLargeGet = await activityAndOutboxSnapshot(largeOrgId);
    const largeList = await request(server!)
      .get(`/api/orgs/${largeOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(largeList.status).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(largeList.body))).toBeGreaterThan(4 * 1024 * 1024);
    const largeExpected = [...largeFixtures].reverse().map((fixture) => fixture.summary);
    expect(largeList.body.backups).toHaveLength(largeExpected.length);
    expect(largeList.body.backups).toEqual(largeExpected);
    expect(largeList.body.backups.at(-1)).toEqual(largeFixtures[0]!.summary);
    expect(await activityAndOutboxSnapshot(largeOrgId)).toEqual(beforeLargeGet);

    const beforeForeignRead = [
      await activityAndOutboxSnapshot(orgId),
      await activityAndOutboxSnapshot(foreignOrgId),
    ];
    const foreignList = await request(server!)
      .get(`/api/orgs/${foreignOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body).toEqual({ backups: [foreign.summary] });
    expect([
      await activityAndOutboxSnapshot(orgId),
      await activityAndOutboxSnapshot(foreignOrgId),
    ]).toEqual(beforeForeignRead);

    const scopedPrimaryList = await request(server!)
      .get(url)
      .set("authorization", `Bearer ${scopedBoardToken}`);
    expect(scopedPrimaryList.status).toBe(200);
    expect(scopedPrimaryList.body).toEqual({ backups: [newer.summary, older.summary] });

    const scopedForeignList = await request(server!)
      .get(`/api/orgs/${foreignOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${scopedBoardToken}`);
    expect(scopedForeignList.status).toBe(403);
    expect(scopedForeignList.body).not.toHaveProperty("backups");

    const unknownOrganization = await request(server!)
      .get(`/api/orgs/${unknownOrgId}/workspace/backups`)
      .set("authorization", `Bearer ${boardToken}`);
    expect(unknownOrganization.status).toBe(404);
    expect(unknownOrganization.body).toEqual({ error: "Organization not found" });

    expect(await backupTableSnapshot()).toEqual(baseline);

    await closeServer(server);
    server = undefined;
    await bridge?.close();
    bridge = undefined;

    // Exercise the same real public route and required-auth middleware with no bridge injected.
    server = await startPublicApp();
    const anonymousAfterBridgeClose = await request(server!).get(url);
    expect(anonymousAfterBridgeClose.status).toBe(401);

    const beforeAuthorizedMissingBridgeGet = await activityAndOutboxSnapshot();
    const backupsBeforeAuthorizedMissingBridgeGet = await backupTableSnapshot();
    const authorizedAfterBridgeClose = await request(server!)
      .get(url)
      .set("authorization", `Bearer ${boardToken}`);
    expect(authorizedAfterBridgeClose.status).toBe(500);
    expect(authorizedAfterBridgeClose.body).toEqual({ error: "Internal server error" });
    expect(await activityAndOutboxSnapshot()).toEqual(beforeAuthorizedMissingBridgeGet);
    expect(await backupTableSnapshot()).toEqual(backupsBeforeAuthorizedMissingBridgeGet);

    await closeServer(server);
    server = undefined;
    bridge = createBridge();
    await bridge.start();
    server = await startPublicApp(bridge);

    const beforeRestartedRead = await activityAndOutboxSnapshot();
    const afterRestart = await request(server)
      .get(url)
      .set("authorization", `Bearer ${boardToken}`);
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body).toEqual({ backups: [newer.summary, older.summary] });
    expect(await activityAndOutboxSnapshot()).toEqual(beforeRestartedRead);
    expect(await backupTableSnapshot()).toEqual(baseline);
  }, 20_000);
});
