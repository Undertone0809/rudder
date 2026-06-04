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
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { buildAgentWorkspaceKey } from "../agent-workspace-key.js";
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X5p1sAAAAASUVORK5CYII=",
  "base64",
);

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
        agentRole: "engineer",
        workspaceKey: originalWorkspaceKey,
      }),
    ]);
  });

  it("returns inline preview metadata for image files", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Image Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Image Org"),
      issuePrefix: "WBI",
      requireBoardApprovalForNewAgents: false,
    });

    const imagePath = path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "costs", "cost-trend.png");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, ONE_BY_ONE_PNG);

    const detail = await workspaceBrowser.readFile(orgId, "projects/costs/cost-trend.png");

    expect(detail).toEqual(expect.objectContaining({
      filePath: "projects/costs/cost-trend.png",
      rootExists: true,
      content: null,
      contentType: "image/png",
      previewKind: "image",
      message: null,
      truncated: false,
    }));
    expect(detail.contentPath).toContain(`/api/orgs/${orgId}/workspace/file/content?`);
    expect(detail.contentPath).toContain("path=projects%2Fcosts%2Fcost-trend.png");
  });

  it("keeps non-image binary files out of inline preview", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Binary Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Binary Org"),
      issuePrefix: "WBB",
      requireBoardApprovalForNewAgents: false,
    });

    const binaryPath = path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "costs", "archive.bin");
    await fs.mkdir(path.dirname(binaryPath), { recursive: true });
    await fs.writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));

    const detail = await workspaceBrowser.readFile(orgId, "projects/costs/archive.bin");

    expect(detail).toEqual(expect.objectContaining({
      filePath: "projects/costs/archive.bin",
      rootExists: true,
      content: null,
      contentType: "application/octet-stream",
      previewKind: "binary",
      contentPath: null,
      message: "Binary files cannot be rendered in Docs.",
      truncated: false,
    }));
  });

  it("returns full text file content instead of truncating Library files", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Full Text Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Full Text Org"),
      issuePrefix: "WBF",
      requireBoardApprovalForNewAgents: false,
    });

    const filePath = path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "long-form", "large.md");
    const content = `# Large file\n\n${"Line with enough content to exceed the old limit.\n".repeat(4_500)}`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");

    const detail = await workspaceBrowser.readFile(orgId, "projects/long-form/large.md");

    expect(detail).toEqual(expect.objectContaining({
      filePath: "projects/long-form/large.md",
      rootExists: true,
      content,
      contentType: "text/markdown",
      previewKind: "text",
      message: null,
      truncated: false,
    }));
  });

  it("searches mentionable Library files beyond the default result window while excluding protected roots", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Mention Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Mention Org"),
      issuePrefix: "WBM",
      requireBoardApprovalForNewAgents: false,
    });

    const root = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(root, "projects", "product"), { recursive: true });
    await Promise.all(
      Array.from({ length: 220 }, (_, index) =>
        fs.writeFile(path.join(root, "projects", "product", `plain-${String(index).padStart(3, "0")}.md`), "# Plain\n", "utf8"),
      ),
    );
    await fs.writeFile(path.join(root, "projects", "product", "z-special-product-brief.md"), "# Product brief\n", "utf8");
    await fs.mkdir(path.join(root, "projects", "special-product-research"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", "worker--1234"), { recursive: true });
    await fs.writeFile(path.join(root, "agents", "worker--1234", "secret-product-brief.md"), "# Agent memory\n", "utf8");
    await fs.mkdir(path.join(root, "skills", "writer"), { recursive: true });
    await fs.writeFile(path.join(root, "skills", "writer", "special-product-skill.md"), "# Skill\n", "utf8");

    const defaultEntries = await workspaceBrowser.listMentionableFiles(orgId);
    expect(defaultEntries).toHaveLength(200);
    expect(defaultEntries.map((entry) => entry.path)).not.toContain("projects/product/z-special-product-brief.md");

    const searchEntries = await workspaceBrowser.listMentionableFiles(orgId, { query: "special-product", limit: 20 });
    expect(searchEntries.map((entry) => [entry.path, entry.isDirectory])).toEqual([
      ["projects/product/z-special-product-brief.md", false],
      ["projects/special-product-research", true],
    ]);
  });

  it("allows normal entry actions below agent workspaces while protecting agent workspace handles", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    const agentId = randomUUID();
    const workspaceKey = buildAgentWorkspaceKey("Ivy", agentId);

    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Mutations Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Mutations Org"),
      issuePrefix: "WBM",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Ivy",
      workspaceKey,
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const root = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "skills", "org-helper"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", workspaceKey, "instructions"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", workspaceKey, "memory"), { recursive: true });
    await fs.mkdir(path.join(root, "agents", workspaceKey, "skills", "agent-helper"), { recursive: true });
    await fs.writeFile(path.join(root, "agents", workspaceKey, "instructions", "HEARTBEAT.md"), "# Heartbeat\n", "utf8");
    await fs.writeFile(path.join(root, "agents", workspaceKey, "instructions", "MEMORY.md"), "# Memory\n", "utf8");
    await fs.writeFile(path.join(root, "agents", workspaceKey, "memory", "notes.md"), "# Notes\n", "utf8");
    await fs.writeFile(path.join(root, "agents", workspaceKey, "skills", "agent-helper", "SKILL.md"), "# Agent skill\n", "utf8");
    await fs.writeFile(path.join(root, "skills", "org-helper", "SKILL.md"), "# Org skill\n", "utf8");
    await fs.mkdir(path.join(root, "projects", "work"), { recursive: true });
    await fs.mkdir(path.join(root, "projects", "final"), { recursive: true });

    await expect(workspaceBrowser.createDirectory(orgId, "projects/work/new-folder")).resolves.toEqual({
      path: "projects/work/new-folder",
      isDirectory: true,
    });
    await expect(workspaceBrowser.createFile(orgId, "projects/work/new-file.md", "# New\n")).resolves.toEqual(
      expect.objectContaining({
        filePath: "projects/work/new-file.md",
        content: "# New\n",
      }),
    );

    await expect(workspaceBrowser.createFile(orgId, "agents/new-agent-root-file.md", "# Blocked\n")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.createDirectory(orgId, `agents/${workspaceKey}/new-folder`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, "agents", "renamed-agents")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, "agents", "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}`, "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/instructions`, "notes")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/instructions`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}/instructions`, "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/instructions/MEMORY.md`, "memory.old")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/instructions/HEARTBEAT.md`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}/instructions/MEMORY.md`, "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/memory`, "notes")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/memory/notes.md`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}/memory/notes.md`, "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/skills/agent-helper/SKILL.md`, "skill-old.md")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/skills/agent-helper`)).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}/skills/agent-helper/SKILL.md`, "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.renameEntry(orgId, "skills", "renamed-skills")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.deleteEntry(orgId, "skills/org-helper/SKILL.md")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, "skills/org-helper", "docs")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, "projects/work/new-file.md", "agents")).rejects.toMatchObject({
      status: 422,
    });
    await expect(workspaceBrowser.moveEntry(orgId, "projects/work/new-file.md", `agents/${workspaceKey}`)).rejects.toMatchObject({
      status: 422,
    });

    await expect(workspaceBrowser.moveEntry(orgId, "projects/work/new-file.md", "projects/final")).resolves.toEqual({
      previousPath: "projects/work/new-file.md",
      path: "projects/final/new-file.md",
      isDirectory: false,
    });
    await expect(fs.readFile(path.join(root, "projects", "final", "new-file.md"), "utf8")).resolves.toBe("# New\n");

    await expect(
      workspaceBrowser.createFile(orgId, `agents/${workspaceKey}/instructions/NOTES.md`, "# Notes\n"),
    ).resolves.toEqual(expect.objectContaining({
      filePath: `agents/${workspaceKey}/instructions/NOTES.md`,
      content: "# Notes\n",
    }));
    await expect(
      workspaceBrowser.createDirectory(orgId, `agents/${workspaceKey}/instructions/scratch`),
    ).resolves.toEqual({
      path: `agents/${workspaceKey}/instructions/scratch`,
      isDirectory: true,
    });
    await expect(
      workspaceBrowser.moveEntry(orgId, `agents/${workspaceKey}/instructions/NOTES.md`, `agents/${workspaceKey}/instructions/scratch`),
    ).resolves.toEqual({
      previousPath: `agents/${workspaceKey}/instructions/NOTES.md`,
      path: `agents/${workspaceKey}/instructions/scratch/NOTES.md`,
      isDirectory: false,
    });
    await expect(
      workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/instructions/scratch/NOTES.md`, "renamed-notes.md"),
    ).resolves.toEqual({
      previousPath: `agents/${workspaceKey}/instructions/scratch/NOTES.md`,
      path: `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`,
      isDirectory: false,
    });
    await expect(
      workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`),
    ).resolves.toEqual({
      path: `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`,
      isDirectory: false,
    });
  });

});
