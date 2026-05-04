import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { workspaceBackupService } from "../services/workspace-backups.js";

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
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Backup Org",
      urlKey: deriveOrganizationUrlKey("Workspace Backup Org"),
      issuePrefix: "WBO",
      requireBoardApprovalForNewAgents: false,
    });
    return orgId;
  }

  it("creates a backup and reads files from the selected version", async () => {
    const orgId = await createOrganization();
    const workspaceRoot = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(workspaceRoot, "plans"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "plans", "roadmap.md"), "# Roadmap\n", "utf8");

    const backup = await service.create({ orgId });

    expect(backup.status).toBe("succeeded");
    expect(backup.fileCount).toBe(1);
    expect(backup.byteSize).toBeGreaterThan(0);
    expect(backup.expiresAt).not.toBeNull();

    const root = await service.listFiles(orgId, backup.id);
    expect(root.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "plans", path: "plans", isDirectory: true }),
    ]));

    const plans = await service.listFiles(orgId, backup.id, "plans");
    expect(plans.entries).toEqual([
      expect.objectContaining({ name: "roadmap.md", path: "plans/roadmap.md", isDirectory: false }),
    ]);

    const file = await service.readFile(orgId, backup.id, "plans/roadmap.md");
    expect(file.content).toBe("# Roadmap\n");
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
});
