import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  libraryEntries,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

  it("returns inline preview metadata for PDF files", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser PDF Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser PDF Org"),
      issuePrefix: "WBP",
      requireBoardApprovalForNewAgents: false,
    });

    const pdfPath = path.join(resolveOrganizationWorkspaceRoot(orgId), "projects", "reports", "brief.pdf");
    await fs.mkdir(path.dirname(pdfPath), { recursive: true });
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7\n%rudder-test\n", "utf8"));

    const detail = await workspaceBrowser.readFile(orgId, "projects/reports/brief.pdf");

    expect(detail).toEqual(expect.objectContaining({
      filePath: "projects/reports/brief.pdf",
      rootExists: true,
      content: null,
      contentType: "application/pdf",
      previewKind: "pdf",
      message: null,
      truncated: false,
    }));
    expect(detail.contentPath).toContain(`/api/orgs/${orgId}/workspace/file/content?`);
    expect(detail.contentPath).toContain("path=projects%2Freports%2Fbrief.pdf");
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

  it("keeps workspace file Library entry ids stable across managed file and directory moves", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Library Entry Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Library Entry Org"),
      issuePrefix: "WBL",
      requireBoardApprovalForNewAgents: false,
    });

    const root = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(root, { recursive: true });

    const created = await workspaceBrowser.createFile(orgId, "projects/work/original.md", "# Original\n");
    expect(created.libraryEntryId).toEqual(expect.any(String));
    const entryId = created.libraryEntryId!;
    expect(created.mentionHref).toBe(`library-entry://${entryId}?p=projects%2Fwork%2Foriginal.md`);
    expect(created.markdownLink).toBe(`[original.md](library-entry://${entryId}?p=projects%2Fwork%2Foriginal.md)`);

    const listed = await workspaceBrowser.listFiles(orgId, "projects/work");
    expect(listed.entries).toContainEqual(expect.objectContaining({
      path: "projects/work/original.md",
      libraryEntryId: entryId,
    }));

    const renamed = await workspaceBrowser.renameEntry(orgId, "projects/work/original.md", "renamed.md");
    expect(renamed).toEqual(expect.objectContaining({
      previousPath: "projects/work/original.md",
      path: "projects/work/renamed.md",
      libraryEntryId: entryId,
    }));
    const afterRename = await workspaceBrowser.readFile(orgId, "projects/work/renamed.md");
    expect(afterRename.libraryEntryId).toBe(entryId);
    expect(afterRename.mentionHref).toBe(`library-entry://${entryId}?p=projects%2Fwork%2Frenamed.md`);
    expect(afterRename.markdownLink).toBe(`[renamed.md](library-entry://${entryId}?p=projects%2Fwork%2Frenamed.md)`);

    await workspaceBrowser.createDirectory(orgId, "projects/final");
    const moved = await workspaceBrowser.moveEntry(orgId, "projects/work/renamed.md", "projects/final");
    expect(moved).toEqual(expect.objectContaining({
      previousPath: "projects/work/renamed.md",
      path: "projects/final/renamed.md",
      libraryEntryId: entryId,
    }));

    const [activeEntry] = await db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.id, entryId));
    expect(activeEntry).toEqual(expect.objectContaining({
      orgId,
      currentPath: "projects/final/renamed.md",
      status: "active",
      title: "renamed.md",
    }));

    const child = await workspaceBrowser.createFile(orgId, "projects/work/nested/child.md", "# Child\n");
    const childEntryId = child.libraryEntryId!;
    await expect(workspaceBrowser.renameEntry(orgId, "projects/work", "research")).resolves.toEqual(
      expect.objectContaining({
        previousPath: "projects/work",
        path: "projects/research",
        isDirectory: true,
        libraryEntryId: null,
      }),
    );
    const [movedChildEntry] = await db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.id, childEntryId));
    expect(movedChildEntry).toEqual(expect.objectContaining({
      currentPath: "projects/research/nested/child.md",
      status: "active",
    }));

    await expect(workspaceBrowser.deleteEntry(orgId, "projects/research")).resolves.toEqual({
      path: "projects/research",
      isDirectory: true,
      libraryEntryId: null,
    });
    const [deletedChildEntry] = await db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.id, childEntryId));
    expect(deletedChildEntry).toEqual(expect.objectContaining({
      currentPath: null,
      status: "deleted",
    }));
  });

  it("creates Library entry ids safely when concurrent listings discover the same file", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Workspace Browser Library Entry Race Org",
      urlKey: deriveOrganizationUrlKey("Workspace Browser Library Entry Race Org"),
      issuePrefix: "WBR",
      requireBoardApprovalForNewAgents: false,
    });

    const root = resolveOrganizationWorkspaceRoot(orgId);
    await fs.mkdir(path.join(root, "projects", "race"), { recursive: true });
    await fs.writeFile(path.join(root, "projects", "race", "reference.md"), "# Reference\n", "utf8");

    const listings = await Promise.all(
      Array.from({ length: 8 }, () => workspaceBrowser.listFiles(orgId, "projects/race")),
    );

    const entryIds = new Set(
      listings.map((listing) => listing.entries.find((entry) => entry.path === "projects/race/reference.md")?.libraryEntryId),
    );
    expect(entryIds.size).toBe(1);
    const [entryId] = [...entryIds];
    expect(entryId).toEqual(expect.any(String));

    const rows = await db
      .select()
      .from(libraryEntries)
      .where(eq(libraryEntries.currentPath, "projects/race/reference.md"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      id: entryId,
      orgId,
      status: "active",
    }));
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

    await expect(workspaceBrowser.moveEntry(orgId, "projects/work/new-file.md", "projects/final")).resolves.toEqual(
      expect.objectContaining({
        previousPath: "projects/work/new-file.md",
        path: "projects/final/new-file.md",
        isDirectory: false,
        libraryEntryId: expect.any(String),
      }),
    );
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
    ).resolves.toEqual(expect.objectContaining({
      previousPath: `agents/${workspaceKey}/instructions/NOTES.md`,
      path: `agents/${workspaceKey}/instructions/scratch/NOTES.md`,
      isDirectory: false,
      libraryEntryId: expect.any(String),
    }));
    await expect(
      workspaceBrowser.renameEntry(orgId, `agents/${workspaceKey}/instructions/scratch/NOTES.md`, "renamed-notes.md"),
    ).resolves.toEqual(expect.objectContaining({
      previousPath: `agents/${workspaceKey}/instructions/scratch/NOTES.md`,
      path: `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`,
      isDirectory: false,
      libraryEntryId: expect.any(String),
    }));
    await expect(
      workspaceBrowser.deleteEntry(orgId, `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`),
    ).resolves.toEqual(expect.objectContaining({
      path: `agents/${workspaceKey}/instructions/scratch/renamed-notes.md`,
      isDirectory: false,
      libraryEntryId: expect.any(String),
    }));
  });

  it("bulk deletes only legacy agent HEARTBEAT.md instruction files", async () => {
    const rudderHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-org-workspace-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";

    const orgId = randomUUID();
    const agentOneId = randomUUID();
    const agentTwoId = randomUUID();
    const agentOneWorkspaceKey = buildAgentWorkspaceKey("Ada", agentOneId);
    const agentTwoWorkspaceKey = buildAgentWorkspaceKey("Bea", agentTwoId);

    await db.insert(organizations).values({
      id: orgId,
      name: "Legacy Heartbeat Org",
      urlKey: deriveOrganizationUrlKey("Legacy Heartbeat Org"),
      issuePrefix: "LHB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentOneId,
        orgId,
        name: "Ada",
        workspaceKey: agentOneWorkspaceKey,
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: agentTwoId,
        orgId,
        name: "Bea",
        workspaceKey: agentTwoWorkspaceKey,
        role: "engineer",
        status: "active",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const root = resolveOrganizationWorkspaceRoot(orgId);
    const agentOneInstructions = path.join(root, "agents", agentOneWorkspaceKey, "instructions");
    const agentTwoInstructions = path.join(root, "agents", agentTwoWorkspaceKey, "instructions");
    const staleInstructions = path.join(root, "agents", "stale-or-manual", "instructions");
    await fs.mkdir(agentOneInstructions, { recursive: true });
    await fs.mkdir(agentTwoInstructions, { recursive: true });
    await fs.mkdir(staleInstructions, { recursive: true });
    await fs.writeFile(path.join(agentOneInstructions, "HEARTBEAT.md"), "# Heartbeat one\n", "utf8");
    await fs.writeFile(path.join(agentOneInstructions, "MEMORY.md"), "# Memory one\n", "utf8");
    await fs.writeFile(path.join(agentTwoInstructions, "HEARTBEAT.md"), "# Heartbeat two\n", "utf8");
    await fs.writeFile(path.join(agentTwoInstructions, "SOUL.md"), "# Soul two\n", "utf8");
    await fs.writeFile(path.join(staleInstructions, "HEARTBEAT.md"), "# Stale heartbeat\n", "utf8");

    const agentOneHeartbeatPath = `agents/${agentOneWorkspaceKey}/instructions/HEARTBEAT.md`;
    const agentTwoHeartbeatPath = `agents/${agentTwoWorkspaceKey}/instructions/HEARTBEAT.md`;
    await workspaceBrowser.readFile(orgId, agentOneHeartbeatPath);
    await workspaceBrowser.readFile(orgId, agentTwoHeartbeatPath);

    const result = await workspaceBrowser.deleteLegacyHeartbeatInstructions(orgId);

    expect(result.deleted.map((entry) => entry.path).sort()).toEqual([
      agentOneHeartbeatPath,
      agentTwoHeartbeatPath,
    ].sort());
    await expect(fs.stat(path.join(agentOneInstructions, "HEARTBEAT.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(agentTwoInstructions, "HEARTBEAT.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(staleInstructions, "HEARTBEAT.md"), "utf8")).resolves.toBe("# Stale heartbeat\n");
    await expect(fs.readFile(path.join(agentOneInstructions, "MEMORY.md"), "utf8")).resolves.toBe("# Memory one\n");
    await expect(fs.readFile(path.join(agentTwoInstructions, "SOUL.md"), "utf8")).resolves.toBe("# Soul two\n");

    const entries = await db.select().from(libraryEntries).where(eq(libraryEntries.orgId, orgId));
    expect(entries.filter((entry) =>
      entry.status === "deleted"
      && entry.currentPath === null
      && entry.title === "HEARTBEAT.md",
    )).toHaveLength(2);
    await expect(workspaceBrowser.deleteLegacyHeartbeatInstructions(orgId)).resolves.toEqual({ deleted: [] });
  });

});
