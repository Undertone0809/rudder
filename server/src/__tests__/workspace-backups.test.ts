import { resolveOrganizationStorageKey } from "@rudderhq/agent-runtime-utils";
import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRuns,
  organizations,
  workspaceBackups,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDefaultBackupDir, resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import {
  reconcileWorkspaceBackupArtifactStorage,
  reconcileWorkspaceRestoreReceipts,
  workspaceBackupService,
} from "../services/workspace-backups.js";

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
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function expectZipContains(buffer: Buffer, value: string) {
  expect(buffer.toString("utf8")).toContain(value);
}

async function unzipArchive(archivePath: string, outputDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("unzip", ["-q", archivePath, "-d", outputDir], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

const RESTORE_CRASH_SCRIPT = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");

const input = JSON.parse(process.env.RUDDER_RESTORE_CRASH_FIXTURE);
const crash = (point) => {
  if (input.crashPoint === point) process.exit(70);
};
const writeReceipt = async (phase) => {
  await fs.mkdir(path.dirname(input.receiptPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(input.receiptPath, JSON.stringify({
    version: 1,
    operationId: input.operationId,
    orgId: input.orgId,
    backupId: input.backupId,
    phase,
    workspaceRoot: input.workspaceRoot,
    stagingRoot: input.stagingRoot,
    rollbackRoot: input.rollbackRoot,
    liveTreeSha256: input.liveTreeSha256,
    stagingTreeSha256: input.stagingTreeSha256,
    expectedTreeSha256: input.expectedTreeSha256,
    preRestoreBackupId: input.preRestoreBackupId,
  }) + "\n", { mode: 0o600 });
};

(async () => {
  await fs.rm(input.stagingRoot, { recursive: true, force: true });
  await fs.rm(input.rollbackRoot, { recursive: true, force: true });
  await fs.cp(input.workspaceRoot, input.stagingRoot, { recursive: true });
  await fs.writeFile(path.join(input.stagingRoot, "notes.md"), "restored\n", "utf8");
  await writeReceipt("prepared");
  crash("after_prepared_receipt");
  await fs.rename(input.workspaceRoot, input.rollbackRoot);
  crash("after_workspace_to_rollback");
  await writeReceipt("live_moved");
  crash("after_live_moved_receipt");
  await fs.rename(input.stagingRoot, input.workspaceRoot);
  crash("after_staging_to_workspace");
  await writeReceipt("committed");
  crash("after_committed_receipt");
  await fs.rm(input.rollbackRoot, { recursive: true, force: true });
  await fs.rm(input.receiptPath, { force: true });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

async function runRestoreCrashChild(input: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      ["-e", RESTORE_CRASH_SCRIPT],
      { env: { ...process.env, RUDDER_RESTORE_CRASH_FIXTURE: JSON.stringify(input) } },
      (error) => {
        if (!error) {
          reject(new Error("restore crash child exited normally; expected injected exit code 70"));
          return;
        }
        if (Number(error.code) === 70) resolve();
        else reject(error);
      },
    );
  });
}

async function startTempDatabase() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backups-db-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("workspace backup service", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof workspaceBackupService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let rudderHome = "";
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backups-home-"));
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    service = workspaceBackupService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(workspaceBackups);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
    await fs.rm(path.join(rudderHome, "instances"), { recursive: true, force: true });
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    if (rudderHome) await fs.rm(rudderHome, { recursive: true, force: true });
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  async function createOrganization() {
    const orgId = randomUUID();
    const suffix = orgId.slice(0, 8);
    await db.insert(organizations).values({
      id: orgId,
      name: `Workspace Backup Org ${suffix}`,
      urlKey: deriveOrganizationUrlKey(`Workspace Backup Org ${suffix}`),
      issuePrefix: `W${suffix.slice(0, 4)}`.toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    return orgId;
  }

  async function makeBackupDue(backupId: string, createdAt = new Date("2026-05-20T08:00:00.000Z")) {
    await db
      .update(workspaceBackups)
      .set({ createdAt, updatedAt: createdAt })
      .where(eq(workspaceBackups.id, backupId));
  }

  it("creates a backup and reads files from the selected version", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "roadmap"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "roadmap", "roadmap.md"), "# Roadmap\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "roadmap", "logo.bin"), Buffer.from([0, 1, 2, 255]));

    const backup = await service.create({ orgId });

    expect(backup.status).toBe("succeeded");
    expect(backup.fileCount).toBe(2);
    expect(backup.byteSize).toBeGreaterThan(0);
    expect(backup.expiresAt).not.toBeNull();
    expect(backup.artifactRef).toContain(path.join("workspaces", resolveOrganizationStorageKey(orgId)));
    expect(backup.artifactRef).not.toContain(path.join("workspaces", orgId));
    expect(path.basename(backup.artifactRef)).toContain(`workspace-${resolveOrganizationStorageKey(orgId)}-`);
    expect(path.basename(backup.artifactRef)).not.toContain(`workspace-${orgId}-`);

    const root = await service.listFiles(orgId, backup.id);
    expect(root.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "projects", path: "projects", isDirectory: true }),
    ]));

    const projectFiles = await service.listFiles(orgId, backup.id, "projects/roadmap");
    expect(projectFiles.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "logo.bin", path: "projects/roadmap/logo.bin", isDirectory: false }),
      expect.objectContaining({ name: "roadmap.md", path: "projects/roadmap/roadmap.md", isDirectory: false }),
    ]));

    const file = await service.readFile(orgId, backup.id, "projects/roadmap/roadmap.md");
    expect(file.content).toBe("# Roadmap\n");

    const download = await service.getDownload(orgId, backup.id);
    expect(download).toEqual(expect.objectContaining({
      artifactRef: backup.artifactRef,
      filename: `${path.basename(backup.artifactRef, ".json")}.zip`,
      contentType: "application/zip",
    }));
    expect(download.byteSize).toBeGreaterThan(0);
    expect(download.archiveSha256).not.toBe(backup.archiveSha256);
    expectZipContains(download.content, "workspace-");
    expectZipContains(download.content, "projects/roadmap/roadmap.md");
    expectZipContains(download.content, "# Roadmap\n");
    const unzipRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-backup-unzip-"));
    try {
      const archivePath = path.join(unzipRoot, "workspace.zip");
      const outputDir = path.join(unzipRoot, "out");
      await fs.writeFile(archivePath, download.content);
      await unzipArchive(archivePath, outputDir);
      const [rootFolderName] = await fs.readdir(outputDir);
      expect(rootFolderName).toBeTruthy();
      const extractedRoot = path.join(outputDir, rootFolderName!);
      await expect(fs.readFile(path.join(extractedRoot, "projects", "roadmap", "roadmap.md"), "utf8"))
        .resolves.toBe("# Roadmap\n");
      await expect(fs.readFile(path.join(extractedRoot, "projects", "roadmap", "logo.bin")))
        .resolves.toEqual(Buffer.from([0, 1, 2, 255]));
    } finally {
      await fs.rm(unzipRoot, { recursive: true, force: true });
    }
  });

  it("uses the bounded v2 file-backed path only when explicitly opted in", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "v2.txt"), "v2 content\n", "utf8");
    const previousFlag = process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED;
    process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED = "true";
    try {
      const backup = await service.create({ orgId });
      expect(path.extname(backup.artifactRef)).toBe(".zip");
      expect(backup.manifest).toMatchObject({
        version: 2,
        policyVersion: expect.any(String),
        identity: expect.objectContaining({ orgId }),
        treeSha256: backup.treeSha256,
      });
      await expect(service.listFiles(orgId, backup.id)).resolves.toMatchObject({
        entries: expect.arrayContaining([expect.objectContaining({ path: "v2.txt", isDirectory: false })]),
      });
      await expect(service.readFile(orgId, backup.id, "v2.txt")).resolves.toMatchObject({ content: "v2 content\n" });
      const download = await service.getDownload(orgId, backup.id);
      expect(download.content).toBeUndefined();
      expect(download.contentStream).toBeDefined();
      const chunks: Buffer[] = [];
      for await (const chunk of download.contentStream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(await fs.readFile(backup.artifactRef));
    } finally {
      if (previousFlag === undefined) delete process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED;
      else process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED = previousFlag;
    }
  });

  it("records a bounded native fallback diagnostic before using the Node writer", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "fallback.txt"), "fallback\n", "utf8");
    const fakeNative = path.join(rudderHome, "fake-native-no-create.mjs");
    await fs.writeFile(fakeNative, `#!/usr/bin/env node
console.log(JSON.stringify({ok:true,protocolVersion:1,capabilities:[]}));
`, { mode: 0o755 });
    const previousV2 = process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED;
    const previousNative = process.env.RUDDER_WORKSPACE_BACKUP_V2_NATIVE;
    const previousPath = process.env.RUDDER_NATIVE_ARCHIVE_PATH;
    process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED = "true";
    process.env.RUDDER_WORKSPACE_BACKUP_V2_NATIVE = "true";
    process.env.RUDDER_NATIVE_ARCHIVE_PATH = fakeNative;
    try {
      const backup = await service.create({ orgId });
      expect(backup.status).toBe("succeeded");
      expect(backup.warnings).toContainEqual(expect.stringMatching(/^Native archive fallback \[capability\/create_unavailable\]:/));
      expect(backup.manifest).toMatchObject({
        warnings: expect.arrayContaining([expect.stringMatching(/^Native archive fallback \[capability\/create_unavailable\]:/)]),
      });
      const inspected = await import("../services/workspace-backup-v2.js").then(({ inspectWorkspaceBackupV2File }) => inspectWorkspaceBackupV2File(backup.artifactRef));
      expect(inspected.manifest).toEqual(backup.manifest);
      await expect(service.readFile(orgId, backup.id, "fallback.txt")).resolves.toMatchObject({ content: "fallback\n" });
    } finally {
      if (previousV2 === undefined) delete process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED; else process.env.RUDDER_WORKSPACE_BACKUP_V2_ENABLED = previousV2;
      if (previousNative === undefined) delete process.env.RUDDER_WORKSPACE_BACKUP_V2_NATIVE; else process.env.RUDDER_WORKSPACE_BACKUP_V2_NATIVE = previousNative;
      if (previousPath === undefined) delete process.env.RUDDER_NATIVE_ARCHIVE_PATH; else process.env.RUDDER_NATIVE_ARCHIVE_PATH = previousPath;
    }
  });

  it("migrates legacy full UUID backup artifact paths and metadata to the short storage key", async () => {
    const orgId = await createOrganization();
    const storageKey = resolveOrganizationStorageKey(orgId);
    const backupId = randomUUID();
    const createdAt = new Date("2026-06-18T08:00:00.000Z");
    const legacyRootPath = path.join(
      rudderHome,
      "instances",
      "test-instance",
      "organizations",
      orgId,
      "workspaces",
    );
    const legacyArtifactRef = path.join(
      resolveDefaultBackupDir(),
      "workspaces",
      orgId,
      `workspace-${orgId}-20260618-080000-${backupId.slice(0, 8)}.json`,
    );
    const artifact = {
      version: 1,
      orgId,
      instanceId: "test-instance",
      createdAt: createdAt.toISOString(),
      rootPath: legacyRootPath,
      entries: [],
      warnings: [],
    };
    const serialized = JSON.stringify(artifact, null, 2);
    await fs.mkdir(path.dirname(legacyArtifactRef), { recursive: true });
    await fs.writeFile(legacyArtifactRef, serialized, "utf8");
    await db.insert(workspaceBackups).values({
      id: backupId,
      orgId,
      status: "succeeded",
      triggerSource: "manual",
      artifactProvider: "local_file",
      artifactRef: legacyArtifactRef,
      archiveSha256: sha256(serialized),
      treeSha256: "empty",
      manifest: {
        version: 1,
        orgId,
        instanceId: "test-instance",
        rootPath: legacyRootPath,
        createdAt: createdAt.toISOString(),
        entryCount: 0,
        fileCount: 0,
        byteSize: 0,
        treeSha256: "empty",
        activeRunCount: 0,
        warnings: [],
      },
      startedAt: createdAt,
      finishedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    });

    const result = await reconcileWorkspaceBackupArtifactStorage(db, [orgId]);

    expect(result.skipped).toEqual([]);
    expect(result.migrated).toEqual([
      expect.objectContaining({
        backupId,
        orgId,
        from: legacyArtifactRef,
        movedArtifact: true,
        updatedArtifact: true,
      }),
    ]);
    const [row] = await db
      .select()
      .from(workspaceBackups)
      .where(eq(workspaceBackups.id, backupId));
    expect(row?.artifactRef).toContain(path.join("workspaces", storageKey));
    expect(row?.artifactRef).not.toContain(path.join("workspaces", orgId));
    expect(path.basename(row!.artifactRef)).toContain(`workspace-${storageKey}-`);
    expect(row?.manifest).toEqual(expect.objectContaining({
      rootPath: resolveOrganizationWorkspaceRoot(orgId),
    }));
    await expect(fs.stat(legacyArtifactRef)).rejects.toMatchObject({ code: "ENOENT" });
    const migratedArtifact = JSON.parse(await fs.readFile(row!.artifactRef, "utf8")) as { rootPath: string };
    expect(migratedArtifact.rootPath).toBe(resolveOrganizationWorkspaceRoot(orgId));
    await expect(service.listFiles(orgId, backupId)).resolves.toMatchObject({ entries: [] });
  });

  it("skips runtime and cache directories when creating workspace backups", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "roadmap"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "roadmap", "roadmap.md"), "# Roadmap\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "agents", "vera--12345678", "Library", "Caches"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "agents", "vera--12345678", "Library", "Caches", "cache.bin"), "cache\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, "agents", "vera--12345678", ".rudder", "instances"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "agents", "vera--12345678", ".rudder", "instances", "state.json"), "{}\n", "utf8");

    const backup = await service.create({ orgId });

    expect(backup.status).toBe("succeeded");
    expect(backup.fileCount).toBe(1);
    expect(backup.warnings).toEqual(expect.arrayContaining([
      "Skipped agents/vera--12345678/.rudder",
      "Skipped agents/vera--12345678/Library",
    ]));

    const projectFiles = await service.listFiles(orgId, backup.id, "projects/roadmap");
    expect(projectFiles.entries).toEqual([
      expect.objectContaining({ name: "roadmap.md", path: "projects/roadmap/roadmap.md", isDirectory: false }),
    ]);
  });

  it("restores a backup after live files change", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "before\n", "utf8");

    const backup = await service.create({ orgId });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "after\n", "utf8");

    const result = await service.restore(orgId, backup.id);

    expect(result.restoredBackup.status).toBe("restored");
    expect(result.preRestoreBackup.status).toBe("succeeded");
    await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8")).resolves.toBe("before\n");
  });

  it.each(["before_publish", "after_publish"] as const)(
    "reconciles a live_moved restore receipt after interruption %s",
    async (interruptionPoint) => {
      const orgId = await createOrganization();
      const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
      await fs.mkdir(workspaceRoot, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");
      const liveBackup = await service.create({ orgId });

      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "restored\n", "utf8");
      const restoredBackup = await service.create({ orgId });

      const operationId = randomUUID();
      const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
      const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
      const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
      const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
      await fs.cp(workspaceRoot, stagingRoot, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");
      await fs.rename(workspaceRoot, rollbackRoot);
      if (interruptionPoint === "after_publish") await fs.rename(stagingRoot, workspaceRoot);

      await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(receiptPath, `${JSON.stringify({
        version: 1,
        operationId,
        orgId,
        backupId: restoredBackup.id,
        phase: "live_moved",
        workspaceRoot,
        stagingRoot,
        rollbackRoot,
        liveTreeSha256: liveBackup.treeSha256,
        stagingTreeSha256: restoredBackup.treeSha256,
        expectedTreeSha256: restoredBackup.treeSha256,
        preRestoreBackupId: liveBackup.id,
      })}\n`, { mode: 0o600 });

      await expect(reconcileWorkspaceRestoreReceipts()).resolves.toEqual({
        recovered: [operationId],
        blocked: [],
      });
      await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8"))
        .resolves.toBe(interruptionPoint === "before_publish" ? "live\n" : "restored\n");
      await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(rollbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    "after_prepared_receipt",
    "after_workspace_to_rollback",
    "after_live_moved_receipt",
    "after_staging_to_workspace",
    "after_committed_receipt",
  ] as const)(
    "reconciles a child-process restore crash at %s",
    async (crashPoint) => {
      const orgId = await createOrganization();
      const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
      await fs.mkdir(workspaceRoot, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");
      const liveBackup = await service.create({ orgId });

      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "restored\n", "utf8");
      const restoredBackup = await service.create({ orgId });
      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");

      const operationId = randomUUID();
      const stagingRoot = path.resolve(path.dirname(workspaceRoot), ".rudder-workspace-restore-staging-" + operationId);
      const rollbackRoot = path.resolve(path.dirname(workspaceRoot), ".rudder-workspace-restore-rollback-" + operationId);
      const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
      const receiptPath = path.join(receiptRoot, orgId + "-" + operationId + ".json");
      await runRestoreCrashChild({
        crashPoint,
        operationId,
        orgId,
        backupId: restoredBackup.id,
        workspaceRoot,
        stagingRoot,
        rollbackRoot,
        receiptPath,
        liveTreeSha256: liveBackup.treeSha256!,
        stagingTreeSha256: restoredBackup.treeSha256!,
        expectedTreeSha256: restoredBackup.treeSha256!,
        preRestoreBackupId: liveBackup.id,
      });

      await expect(reconcileWorkspaceRestoreReceipts(db)).resolves.toEqual({
        recovered: [operationId],
        blocked: [],
      });
      if (["after_staging_to_workspace", "after_committed_receipt"].includes(crashPoint)) {
        const [restoredRow] = await db
          .select({ status: workspaceBackups.status })
          .from(workspaceBackups)
          .where(eq(workspaceBackups.id, restoredBackup.id));
        expect(restoredRow?.status).toBe("restored");
      }
      await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8"))
        .resolves.toBe(["after_staging_to_workspace", "after_committed_receipt"].includes(crashPoint) ? "restored\n" : "live\n");
      await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(rollbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("blocks live_moved reconciliation when the published tree does not match the receipt", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");
    const liveBackup = await service.create({ orgId });

    const operationId = randomUUID();
    const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
    const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
    const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
    const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
    await fs.cp(workspaceRoot, stagingRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, "notes.md"), "tampered\n", "utf8");
    await fs.rename(workspaceRoot, rollbackRoot);
    await fs.writeFile(path.join(rollbackRoot, "notes.md"), "corrupt-live\n", "utf8");
    await fs.rename(stagingRoot, workspaceRoot);

    await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(receiptPath, `${JSON.stringify({
      version: 1,
      operationId,
      orgId,
      backupId: liveBackup.id,
      phase: "live_moved",
      workspaceRoot,
      stagingRoot,
      rollbackRoot,
      liveTreeSha256: liveBackup.treeSha256,
      stagingTreeSha256: "0".repeat(64),
      expectedTreeSha256: "1".repeat(64),
      preRestoreBackupId: liveBackup.id,
    })}\n`, { mode: 0o600 });

    await expect(reconcileWorkspaceRestoreReceipts()).resolves.toEqual({
      recovered: [],
      blocked: [expect.objectContaining({
        operationId,
        error: "workspace and rollback roots match neither recorded tree",
      })],
    });
    await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8")).resolves.toBe("tampered\n");
    await expect(fs.readFile(path.join(rollbackRoot, "notes.md"), "utf8")).resolves.toBe("corrupt-live\n");
    await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(rollbackRoot)).resolves.toBeDefined();
    await expect(fs.stat(receiptPath)).resolves.toBeDefined();
  });

  it("blocks live_moved reconciliation when the workspace is missing and rollback is tampered", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "live\n", "utf8");
    const liveBackup = await service.create({ orgId });

    const operationId = randomUUID();
    const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
    const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
    const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
    const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(rollbackRoot, { recursive: true });
    await fs.writeFile(path.join(rollbackRoot, "notes.md"), "tampered-live\n", "utf8");
    await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(receiptPath, `${JSON.stringify({
      version: 1,
      operationId,
      orgId,
      backupId: liveBackup.id,
      phase: "live_moved",
      workspaceRoot,
      stagingRoot,
      rollbackRoot,
      liveTreeSha256: liveBackup.treeSha256,
      stagingTreeSha256: liveBackup.treeSha256,
      expectedTreeSha256: liveBackup.treeSha256,
      preRestoreBackupId: liveBackup.id,
    })}\n`, { mode: 0o600 });

    await expect(reconcileWorkspaceRestoreReceipts(db)).resolves.toEqual({
      recovered: [],
      blocked: [expect.objectContaining({
        operationId,
        error: "rollback tree does not match recorded live tree",
      })],
    });
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(rollbackRoot, "notes.md"), "utf8")).resolves.toBe("tampered-live\n");
    await expect(fs.stat(rollbackRoot)).resolves.toBeDefined();
    await expect(fs.stat(receiptPath)).resolves.toBeDefined();
  });

  it("reconciles committed restore receipts without deleting the published workspace", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "restored\n", "utf8");
    const backup = await service.create({ orgId });
    const operationId = randomUUID();
    const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
    const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
    const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
    const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.writeFile(path.join(stagingRoot, "stale.tmp"), "stale\n", "utf8");
    await fs.mkdir(rollbackRoot, { recursive: true });
    await fs.writeFile(path.join(rollbackRoot, "old.txt"), "old\n", "utf8");
    await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(receiptPath, `${JSON.stringify({
      version: 1,
      operationId,
      orgId,
      backupId: backup.id,
      phase: "committed",
      workspaceRoot,
      stagingRoot,
      rollbackRoot,
      liveTreeSha256: null,
      stagingTreeSha256: backup.treeSha256,
      expectedTreeSha256: backup.treeSha256,
      preRestoreBackupId: backup.id,
    })}\n`, { mode: 0o600 });

    await expect(reconcileWorkspaceRestoreReceipts(db)).resolves.toEqual({
      recovered: [operationId],
      blocked: [],
    });
    await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8")).resolves.toBe("restored\n");
    await expect(fs.stat(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(rollbackRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["missing_workspace", "mismatched_workspace"] as const)(
    "blocks committed reconciliation when the published workspace is %s",
    async (failure) => {
      const orgId = await createOrganization();
      const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
      await fs.mkdir(workspaceRoot, { recursive: true });
      await fs.writeFile(path.join(workspaceRoot, "notes.md"), "restored\n", "utf8");
      const backup = await service.create({ orgId });
      const operationId = randomUUID();
      const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
      const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
      const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
      const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
      if (failure === "missing_workspace") {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
      } else {
        await fs.writeFile(path.join(workspaceRoot, "notes.md"), "tampered\n", "utf8");
      }
      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.writeFile(path.join(stagingRoot, "stale.tmp"), "stale\n", "utf8");
      await fs.mkdir(rollbackRoot, { recursive: true });
      await fs.writeFile(path.join(rollbackRoot, "old.txt"), "old\n", "utf8");
      await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(receiptPath, `${JSON.stringify({
        version: 1,
        operationId,
        orgId,
        backupId: backup.id,
        phase: "committed",
        workspaceRoot,
        stagingRoot,
        rollbackRoot,
        liveTreeSha256: null,
        stagingTreeSha256: backup.treeSha256,
        expectedTreeSha256: backup.treeSha256,
        preRestoreBackupId: backup.id,
      })}\n`, { mode: 0o600 });

      await expect(reconcileWorkspaceRestoreReceipts(db)).resolves.toEqual({
        recovered: [],
        blocked: [expect.objectContaining({
          operationId,
          error: failure === "missing_workspace"
            ? "committed receipt workspace is missing"
            : "committed workspace tree does not match receipt",
        })],
      });
      await expect(fs.stat(receiptPath)).resolves.toBeDefined();
      await expect(fs.stat(stagingRoot)).resolves.toBeDefined();
      await expect(fs.stat(rollbackRoot)).resolves.toBeDefined();
      if (failure === "missing_workspace") {
        await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(fs.readFile(path.join(workspaceRoot, "notes.md"), "utf8")).resolves.toBe("tampered\n");
      }
    },
  );

  it("repairs a sparse workspace from the latest richer backup without duplicating the recovered version", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "approved\n", "utf8");
    for (let index = 0; index < 10; index += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, "projects", "foundria-llc", "tax", `support-${index}.md`),
        `support ${index}\n`,
        "utf8",
      );
    }

    const richBackup = await service.create({ orgId, triggerSource: "manual" });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");

    const scheduled = await service.runScheduledBackups({
      now: new Date(Date.now() + 25 * 60 * 60 * 1000),
    });

    expect(scheduled.errors).toEqual([]);
    expect(scheduled.created).toHaveLength(0);
    expect(scheduled.skippedDetails).toEqual([
      expect.objectContaining({
        orgId,
        reason: "unchanged",
        comparedBackupId: richBackup.id,
        treeSha256: richBackup.treeSha256,
      }),
    ]);
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "utf8"))
      .resolves.toBe("approved\n");
  });

  it.each(["recovery_required", "committed"] as const)(
    "does not create or modify a sparse workspace while a %s restore receipt is present",
    async (phase) => {
      const orgId = await createOrganization();
      const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
      await fs.mkdir(workspaceRoot, { recursive: true });
      for (let index = 0; index < 10; index += 1) {
        await fs.writeFile(path.join(workspaceRoot, `backup-${index}.txt`), `backup ${index}\n`, "utf8");
      }
      const backup = await service.create({ orgId, triggerSource: "manual" });
      const operationId = randomUUID();
      const stagingRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-staging-${operationId}`);
      const rollbackRoot = path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-rollback-${operationId}`);
      const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
      const receiptPath = path.join(receiptRoot, `${orgId}-${operationId}.json`);
      await fs.rm(workspaceRoot, { recursive: true, force: true });
      await fs.mkdir(receiptRoot, { recursive: true, mode: 0o700 });
      await fs.writeFile(receiptPath, `${JSON.stringify({
        version: 1,
        operationId,
        orgId,
        backupId: backup.id,
        phase,
        workspaceRoot,
        stagingRoot,
        rollbackRoot,
        liveTreeSha256: null,
        stagingTreeSha256: backup.treeSha256,
        expectedTreeSha256: backup.treeSha256,
        preRestoreBackupId: backup.id,
      })}\n`, { mode: 0o600 });

      await expect(service.recoverSparseWorkspaceFromLatestBackup(orgId)).rejects.toMatchObject({
        status: 409,
        details: { code: "restore_recovery_required" },
      });
      await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receiptPath)).resolves.toBeDefined();

      await makeBackupDue(backup.id);
      const scheduled = await service.runScheduledBackups({ now: new Date("2026-05-21T08:00:00.000Z") });
      expect(scheduled.created).toEqual([]);
      expect(scheduled.sparseRecoveries).toEqual([]);
      expect(scheduled.errors).toEqual([
        expect.objectContaining({ orgId, message: expect.stringContaining("Workspace restore requires recovery") }),
      ]);
      await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(receiptPath)).resolves.toBeDefined();
    },
  );

  it("preserves conflicting live files while repairing missing sparse workspace files", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Backup README\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "approved\n", "utf8");
    for (let index = 0; index < 10; index += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, "projects", "foundria-llc", "tax", `support-${index}.md`),
        `support ${index}\n`,
        "utf8",
      );
    }

    const backup = await service.create({ orgId, triggerSource: "manual" });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Live README\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), "live file where backup has a directory\n", "utf8");

    const recovery = await service.recoverSparseWorkspaceFromLatestBackup(orgId);

    expect(recovery).toEqual(expect.objectContaining({
      recovered: false,
      backupId: backup.id,
      currentFileCount: 2,
      backupFileCount: backup.fileCount,
      reason: "no missing files restored",
    }));
    expect(recovery.skippedConflictingFiles).toEqual(expect.arrayContaining([
      "projects/foundria-llc/README.md",
      "projects/foundria-llc/tax",
      "projects/foundria-llc/tax/147c-letter.md",
    ]));
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "utf8"))
      .resolves.toBe("# Live README\n");
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), "utf8"))
      .resolves.toBe("live file where backup has a directory\n");
  });

  it("falls back to an older richer backup when the latest sparse-repair candidate is corrupt", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "approved\n", "utf8");
    for (let index = 0; index < 10; index += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, "projects", "foundria-llc", "tax", `support-${index}.md`),
        `support ${index}\n`,
        "utf8",
      );
    }

    const goodBackup = await service.create({ orgId, triggerSource: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const corruptLatestBackup = await service.create({ orgId, triggerSource: "manual" });
    await fs.writeFile(corruptLatestBackup.artifactRef, "{\"corrupt\":true}\n", "utf8");
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");

    const scheduled = await service.runScheduledBackups({
      now: new Date(Date.now() + 25 * 60 * 60 * 1000),
    });

    expect(scheduled.errors).toEqual([]);
    expect(scheduled.sparseRecoveries).toEqual([
      expect.objectContaining({
        recovered: true,
        backupId: goodBackup.id,
      }),
    ]);
    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.fileCount).toBeGreaterThanOrEqual(goodBackup.fileCount);
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "utf8"))
      .resolves.toBe("approved\n");
  });

  it("prefers the richest backup over a newer valid sparse backup when repairing a sparse workspace", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc", "tax"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "approved\n", "utf8");
    for (let index = 0; index < 12; index += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, "projects", "foundria-llc", "tax", `support-${index}.md`),
        `support ${index}\n`,
        "utf8",
      );
    }

    const richestBackup = await service.create({ orgId, triggerSource: "manual" });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Sparse\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "notes.md"), "newer sparse backup\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newerSparseBackup = await service.create({ orgId, triggerSource: "manual" });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(workspaceRoot, "projects", "foundria-llc"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "foundria-llc", "README.md"), "# Foundria\n", "utf8");

    const recovery = await service.recoverSparseWorkspaceFromLatestBackup(orgId);

    expect(newerSparseBackup.fileCount).toBeLessThan(richestBackup.fileCount);
    expect(recovery).toEqual(expect.objectContaining({
      recovered: true,
      backupId: richestBackup.id,
      backupFileCount: richestBackup.fileCount,
    }));
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "tax", "147c-letter.md"), "utf8"))
      .resolves.toBe("approved\n");
    await expect(fs.readFile(path.join(workspaceRoot, "projects", "foundria-llc", "notes.md"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes backup artifacts from the visible history", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "scratch.txt"), "backup\n", "utf8");

    const backup = await service.create({ orgId });
    const deleted = await service.remove(orgId, backup.id);

    expect(deleted.status).toBe("deleted");
    await expect(service.list(orgId)).resolves.toEqual([]);
  });

  it("blocks downloads when the artifact checksum no longer matches metadata", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "scratch.txt"), "backup\n", "utf8");

    const backup = await service.create({ orgId });
    await fs.writeFile(backup.artifactRef, "{\"tampered\":true}\n", "utf8");

    await expect(service.getDownload(orgId, backup.id)).rejects.toMatchObject({
      status: 422,
      message: "Workspace backup artifact checksum does not match the recorded backup metadata",
    });
  });

  it("does not reuse a same-size corrupted artifact for scheduled unchanged detection", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);
    const artifact = await fs.readFile(initial.artifactRef);
    const changedByte = artifact[0] === 0x7b ? 0x5b : 0x7b;
    artifact[0] = changedByte;
    await fs.writeFile(initial.artifactRef, artifact);

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.id).not.toBe(initial.id);
    expect(scheduled.skippedDetails).toEqual([]);
  });

  it("creates scheduled backups and prunes expired versions", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");

    const scheduled = await service.runScheduledBackups();

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.triggerSource).toBe("scheduled");
    expect(scheduled.created[0]?.expiresAt).not.toBeNull();

    await db
      .update(workspaceBackups)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceBackups.id, scheduled.created[0]!.id));

    const deleted = await service.pruneExpired(new Date());

    expect(deleted).toHaveLength(1);
    await expect(service.list(orgId)).resolves.toEqual([]);
  });

  it("skips a due scheduled backup when the canonical workspace tree is unchanged", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "projects"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "projects", "daily.md"), "snapshot\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);

    const artifactNamesBefore = await fs.readdir(path.dirname(initial.artifactRef));
    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toEqual([]);
    expect(scheduled.failed).toEqual([]);
    expect(scheduled.skipped).toBe(1);
    expect(scheduled.skippedDetails).toEqual([{
      orgId,
      reason: "unchanged",
      comparedBackupId: initial.id,
      treeSha256: initial.treeSha256,
    }]);
    const persisted = await service.list(orgId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.manifest).toEqual(expect.objectContaining({
      lastScheduledCheck: {
        checkedAt: "2026-05-20T11:00:00.000Z",
        result: "unchanged",
        treeSha256: initial.treeSha256,
      },
    }));
    await expect(fs.readdir(path.dirname(initial.artifactRef))).resolves.toEqual(artifactNamesBefore);

    const nextHourlyTick = await service.runScheduledBackups({
      now: new Date("2026-05-20T12:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });
    expect(nextHourlyTick.skippedDetails).toEqual([
      expect.objectContaining({ orgId, reason: "not_due", comparedBackupId: initial.id }),
    ]);
  });

  it("creates a scheduled backup when file contents change without relying on directory mtime", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    const filePath = path.join(workspaceRoot, "daily.md");
    await fs.writeFile(filePath, "before\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);
    const rootStat = await fs.stat(workspaceRoot);
    await fs.writeFile(filePath, "after!\n", "utf8");
    await fs.utimes(workspaceRoot, rootStat.atime, rootStat.mtime);

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.treeSha256).not.toBe(initial.treeSha256);
    expect(scheduled.skippedDetails).toEqual([]);
  });

  it.each([
    {
      name: "adds",
      mutate: async (workspaceRoot: string) => {
        await fs.writeFile(path.join(workspaceRoot, "added.md"), "added\n", "utf8");
      },
    },
    {
      name: "deletes",
      mutate: async (workspaceRoot: string) => {
        await fs.rm(path.join(workspaceRoot, "original.md"));
      },
    },
    {
      name: "renames",
      mutate: async (workspaceRoot: string) => {
        await fs.rename(path.join(workspaceRoot, "original.md"), path.join(workspaceRoot, "renamed.md"));
      },
    },
  ])("creates a scheduled backup when the workspace $name a file", async ({ mutate }) => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "original.md"), "original\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);
    await mutate(workspaceRoot);

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.treeSha256).not.toBe(initial.treeSha256);
  });

  it("ignores runtime, cache, and temporary-file churn during scheduled change detection", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "durable.md"), "durable\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);
    await fs.mkdir(path.join(workspaceRoot, ".cache", "runtime"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".cache", "runtime", "state.json"), "{}\n", "utf8");
    await fs.mkdir(path.join(workspaceRoot, ".tmp"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".tmp", "agent-state.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "durable.md.tmp-123"), "partial\n", "utf8");

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toEqual([]);
    expect(scheduled.skippedDetails).toEqual([
      expect.objectContaining({ orgId, reason: "unchanged", comparedBackupId: initial.id }),
    ]);
  });

  it("retries after a failed scheduled backup instead of treating the failure as freshness", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");
    const failedAt = new Date("2026-05-20T10:59:00.000Z");
    await db.insert(workspaceBackups).values({
      id: randomUUID(),
      orgId,
      status: "failed",
      triggerSource: "scheduled",
      artifactProvider: "local_file",
      artifactRef: path.join(rudderHome, "missing-failed-workspace-backup.json"),
      error: "simulated write failure",
      startedAt: failedAt,
      finishedAt: failedAt,
      createdAt: failedAt,
      updatedAt: failedAt,
    });

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.status).toBe("succeeded");
    expect(scheduled.skippedDetails).toEqual([]);
  });

  it.each([
    {
      name: "is missing its artifact",
      invalidate: async (backup: { id: string; artifactRef: string }) => {
        await fs.rm(backup.artifactRef);
      },
    },
    {
      name: "comes from a legacy row without a tree hash",
      invalidate: async (backup: { id: string; artifactRef: string }) => {
        await db.update(workspaceBackups).set({ treeSha256: null }).where(eq(workspaceBackups.id, backup.id));
      },
    },
  ])("creates a replacement when the latest successful backup $name", async ({ invalidate }) => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");
    const initial = await service.create({ orgId, triggerSource: "scheduled" });
    await makeBackupDue(initial.id);
    await invalidate(initial);

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.id).not.toBe(initial.id);
    expect(scheduled.skippedDetails).toEqual([]);
  });

  it("keeps manual and pre-restore backups forced even when their tree hash is unchanged", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "notes.md"), "same\n", "utf8");

    const firstManual = await service.create({ orgId, triggerSource: "manual" });
    const secondManual = await service.create({ orgId, triggerSource: "manual" });
    const restored = await service.restore(orgId, firstManual.id);

    expect(secondManual.id).not.toBe(firstManual.id);
    expect(secondManual.treeSha256).toBe(firstManual.treeSha256);
    expect(restored.preRestoreBackup.triggerSource).toBe("pre_restore");
    expect(restored.preRestoreBackup.id).not.toBe(secondManual.id);
    expect(restored.preRestoreBackup.treeSha256).toBe(firstManual.treeSha256);
    await expect(service.list(orgId)).resolves.toHaveLength(3);
  });

  it("prunes expired backups even when another organization is skipped as unchanged", async () => {
    const unchangedOrgId = await createOrganization();
    const unchangedRoot = resolveOrganizationWorkspaceRoot(unchangedOrgId);
    await fs.mkdir(unchangedRoot, { recursive: true });
    await fs.writeFile(path.join(unchangedRoot, "daily.md"), "snapshot\n", "utf8");
    const unchanged = await service.create({ orgId: unchangedOrgId, triggerSource: "scheduled" });
    await makeBackupDue(unchanged.id);

    const expiredOrgId = await createOrganization();
    const expiredAt = new Date("2026-05-19T08:00:00.000Z");
    const expiredId = randomUUID();
    await db.insert(workspaceBackups).values({
      id: expiredId,
      orgId: expiredOrgId,
      status: "failed",
      triggerSource: "scheduled",
      artifactProvider: "local_file",
      artifactRef: path.join(rudderHome, "already-missing-expired-backup.json"),
      error: "expired failure",
      startedAt: expiredAt,
      finishedAt: expiredAt,
      expiresAt: new Date("2026-05-20T10:00:00.000Z"),
      createdAt: expiredAt,
      updatedAt: expiredAt,
    });

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.deleted).toEqual([
      expect.objectContaining({ id: expiredId, status: "deleted" }),
    ]);
    expect(scheduled.skippedDetails).toEqual([
      expect.objectContaining({ orgId: unchangedOrgId, reason: "unchanged" }),
    ]);
  });

  it("serializes concurrent scheduler calls so only one artifact is created per organization", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");
    const now = new Date("2026-05-20T11:00:00.000Z");

    const [first, second] = await Promise.all([
      service.runScheduledBackups({ now }),
      workspaceBackupService(db).runScheduledBackups({ now }),
    ]);

    expect(first.created.length + second.created.length).toBe(1);
    await expect(service.list(orgId)).resolves.toHaveLength(1);
  });

  it("commits the scheduled running claim before writing the artifact", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");

    let signalRenameStarted!: () => void;
    const renameStarted = new Promise<void>((resolve) => {
      signalRenameStarted = resolve;
    });
    let releaseRename!: () => void;
    const renameRelease = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      signalRenameStarted();
      await renameRelease;
      return await originalRename(oldPath, newPath);
    });

    const scheduledPromise = service.runScheduledBackups({ now: new Date("2026-05-20T11:00:00.000Z") });
    try {
      await Promise.race([
        renameStarted,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for scheduled artifact write")), 2_000);
        }),
      ]);

      const [runningRow] = await db
        .select()
        .from(workspaceBackups)
        .where(eq(workspaceBackups.orgId, orgId));
      expect(runningRow).toEqual(expect.objectContaining({
        orgId,
        status: "running",
        triggerSource: "scheduled",
      }));
      const stateWhileBlocked = await Promise.race([
        scheduledPromise.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
      ]);
      expect(stateWhileBlocked).toBe("blocked");
    } finally {
      releaseRename();
      renameSpy.mockRestore();
    }

    const scheduled = await scheduledPromise;
    expect(scheduled.created).toEqual([
      expect.objectContaining({ orgId, status: "succeeded" }),
    ]);
  });

  it("waits for the organization scheduler advisory lock before checking or creating a backup", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");

    let releaseLock!: () => void;
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      signalLockHeld = resolve;
    });
    const lockTransaction = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace-backup-scheduled:${orgId}`}))`);
      signalLockHeld();
      await lockRelease;
    });
    await lockHeld;

    const scheduledPromise = service.runScheduledBackups({ now: new Date("2026-05-20T11:00:00.000Z") });
    const stateBeforeRelease = await Promise.race([
      scheduledPromise.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);

    expect(stateBeforeRelease).toBe("blocked");
    await expect(service.list(orgId)).resolves.toEqual([]);
    releaseLock();
    await lockTransaction;
    const scheduled = await scheduledPromise;
    expect(scheduled.created).toHaveLength(1);
  });

  it("isolates scheduled change detection across organizations", async () => {
    const unchangedOrgId = await createOrganization();
    const changedOrgId = await createOrganization();
    const unchangedRoot = resolveOrganizationWorkspaceRoot(unchangedOrgId);
    const changedRoot = resolveOrganizationWorkspaceRoot(changedOrgId);
    await fs.mkdir(unchangedRoot, { recursive: true });
    await fs.mkdir(changedRoot, { recursive: true });
    await fs.writeFile(path.join(unchangedRoot, "daily.md"), "same\n", "utf8");
    await fs.writeFile(path.join(changedRoot, "daily.md"), "before\n", "utf8");
    const unchanged = await service.create({ orgId: unchangedOrgId, triggerSource: "scheduled" });
    const changed = await service.create({ orgId: changedOrgId, triggerSource: "scheduled" });
    await makeBackupDue(unchanged.id);
    await makeBackupDue(changed.id);
    await fs.writeFile(path.join(changedRoot, "daily.md"), "after\n", "utf8");

    const scheduled = await service.runScheduledBackups({
      now: new Date("2026-05-20T11:00:00.000Z"),
      intervalMs: 2 * 60 * 60 * 1000,
    });

    expect(scheduled.created).toEqual([
      expect.objectContaining({ orgId: changedOrgId }),
    ]);
    expect(scheduled.skippedDetails).toEqual([
      expect.objectContaining({ orgId: unchangedOrgId, reason: "unchanged" }),
    ]);
  });

  it("uses a shorter due interval for running scheduler ticks than offline startup catch-up", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");

    const initialNow = new Date("2026-05-20T08:00:00.000Z");
    const first = await service.runScheduledBackups({ now: initialNow });
    expect(first.created).toHaveLength(1);
    await db
      .update(workspaceBackups)
      .set({ createdAt: initialNow, updatedAt: initialNow })
      .where(eq(workspaceBackups.id, first.created[0]!.id));

    const threeHoursLater = new Date(initialNow.getTime() + 3 * 60 * 60 * 1000);
    const offline = await service.runScheduledBackups({
      now: threeHoursLater,
      intervalMs: 24 * 60 * 60 * 1000,
    });
    expect(offline.created).toHaveLength(0);
    expect(offline.skipped).toBe(1);

    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "changed snapshot\n", "utf8");
    const running = await service.runScheduledBackups({
      now: threeHoursLater,
      intervalMs: 2 * 60 * 60 * 1000,
    });
    expect(running.created).toHaveLength(1);
  });

  it("marks stale running backups as failed before creating the next scheduled backup", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "daily.md"), "snapshot\n", "utf8");

    const staleBackupId = randomUUID();
    const now = new Date("2026-05-20T12:00:00.000Z");
    const staleStartedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await db.insert(workspaceBackups).values({
      id: staleBackupId,
      orgId,
      status: "running",
      triggerSource: "scheduled",
      artifactProvider: "local_file",
      artifactRef: path.join(rudderHome, "missing-workspace-backup.json"),
      startedAt: staleStartedAt,
      createdAt: staleStartedAt,
      updatedAt: staleStartedAt,
    });

    const scheduled = await service.runScheduledBackups({ now });

    expect(scheduled.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: staleBackupId,
        status: "failed",
        error: "Workspace backup timed out before writing an artifact",
      }),
    ]));
    expect(scheduled.created).toHaveLength(1);
    expect(scheduled.created[0]?.status).toBe("succeeded");

    const [staleRow] = await db
      .select()
      .from(workspaceBackups)
      .where(eq(workspaceBackups.id, staleBackupId));
    expect(staleRow?.status).toBe("failed");
  });
});
