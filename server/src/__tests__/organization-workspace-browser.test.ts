import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudder/db";
import { deriveOrganizationUrlKey } from "@rudder/shared";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";

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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-browser-"));
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

describe("organization workspace browser", () => {
  let db!: ReturnType<typeof createDb>;
  let workspaceBrowser!: ReturnType<typeof organizationWorkspaceBrowserService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const cleanupDirs = new Set<string>();
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    workspaceBrowser = organizationWorkspaceBrowserService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(organizations);
    for (const dir of cleanupDirs) {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("hides internal cache and system files from nested workspace listings", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Org"),
      issuePrefix: "WBO",
      requireBoardApprovalForNewAgents: false,
    });

    const agentWorkspaceRoot = path.join(resolveOrganizationWorkspaceRoot(orgId), "agents", "ceo--example");
    await fs.mkdir(path.join(agentWorkspaceRoot, ".cache"), { recursive: true });
    await fs.mkdir(path.join(agentWorkspaceRoot, ".npm"), { recursive: true });
    await fs.mkdir(path.join(agentWorkspaceRoot, ".nvm"), { recursive: true });
    await fs.writeFile(path.join(agentWorkspaceRoot, ".DS_Store"), "", "utf8");
    await fs.mkdir(path.join(agentWorkspaceRoot, "instructions"), { recursive: true });
    await fs.writeFile(path.join(agentWorkspaceRoot, "instructions", "HEARTBEAT.md"), "# Heartbeat\n", "utf8");

    const listing = await workspaceBrowser.listFiles(orgId, "agents/ceo--example");

    expect(listing.entries.map((entry) => entry.name)).toEqual(["instructions"]);
  });

  it("shows the current agent name for agent workspace directories while preserving workspaceKey paths", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    const agentId = randomUUID();
    const originalWorkspaceKey = buildAgentWorkspaceKey("Nia", agentId);

    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Identity Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Identity Org"),
      issuePrefix: "WBI",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Jade",
      icon: "🦊",
      workspaceKey: originalWorkspaceKey,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await fs.mkdir(path.join(resolveOrganizationWorkspaceRoot(orgId), "agents", originalWorkspaceKey), { recursive: true });

    const listing = await workspaceBrowser.listFiles(orgId, "agents");

    expect(listing.entries).toEqual([
      expect.objectContaining({
        name: originalWorkspaceKey,
        path: `agents/${originalWorkspaceKey}`,
        isDirectory: true,
        displayLabel: "Jade",
        entityType: "agent_workspace",
        agentId,
        agentIcon: "🦊",
        workspaceKey: originalWorkspaceKey,
      }),
    ]);
  });
});
