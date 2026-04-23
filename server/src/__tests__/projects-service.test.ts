import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  organizations,
  organizationResources,
  projectResourceAttachments,
  projectWorkspaces,
  projects,
} from "@rudder/db";
import { deriveOrganizationUrlKey } from "@rudder/shared";
import { projectService } from "../services/projects.js";
import { resolveOrganizationWorkspaceRoot } from "../home-paths.js";

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-projects-service-"));
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

describe("project service workspace resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let projectSvc!: ReturnType<typeof projectService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const cleanupDirs = new Set<string>();
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    projectSvc = projectService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectResourceAttachments);
    await db.delete(organizationResources);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(organizations);
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
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
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses the fixed organization workspace root as the project codebase without creating project workspaces", async () => {
    const rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-projects-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Shared Workspace Org",
      urlKey: deriveOrganizationUrlKey("Shared Workspace Org"),
      issuePrefix: "SWO",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await projectSvc.create(orgId, {
      name: "Control Plane",
      status: "planned",
    });

    expect(created.workspaces).toEqual([]);
    expect(created.primaryWorkspace).toBeNull();
    expect(created.codebase.configured).toBe(true);
    expect(created.codebase.scope).toBe("organization");
    expect(created.codebase.workspaceId).toBeNull();
    expect(created.codebase.repoUrl).toBeNull();
    expect(created.codebase.localFolder).toBe(resolveOrganizationWorkspaceRoot(orgId));
    expect(created.codebase.effectiveLocalFolder).toBe(resolveOrganizationWorkspaceRoot(orgId));
    expect(created.codebase.origin).toBe("local_folder");

    const persistedWorkspaces = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, created.id));
    expect(persistedWorkspaces).toEqual([]);
  });

  it("keeps legacy project workspace records internal while resolving project codebase to the org root", async () => {
    const rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-projects-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Legacy Workspace Org",
      urlKey: deriveOrganizationUrlKey("Legacy Workspace Org"),
      issuePrefix: "LWO",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await projectSvc.create(orgId, {
      name: "Legacy Project",
      status: "planned",
    });

    const workspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      orgId,
      projectId: created.id,
      name: "Primary workspace",
      sourceType: "git_repo",
      cwd: "/tmp/rudder-legacy-project",
      repoUrl: "https://github.com/acme/legacy-repo",
      repoRef: "main",
      defaultRef: "main",
      isPrimary: true,
    });

    const reloaded = await projectSvc.getById(created.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.codebase.configured).toBe(true);
    expect(reloaded?.codebase.scope).toBe("organization");
    expect(reloaded?.codebase.workspaceId).toBeNull();
    expect(reloaded?.codebase.repoUrl).toBeNull();
    expect(reloaded?.codebase.localFolder).toBe(resolveOrganizationWorkspaceRoot(orgId));
    expect(reloaded?.primaryWorkspace?.id).toBe(workspaceId);
    expect(reloaded?.workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
  });

  it("creates and returns project resource attachments from existing and inline org resources", async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Resource Org",
      urlKey: deriveOrganizationUrlKey("Resource Org"),
      issuePrefix: "RES",
      requireBoardApprovalForNewAgents: false,
    });

    const existingResource = await db.insert(organizationResources).values({
      orgId,
      name: "Existing spec",
      kind: "file",
      locator: "~/projects/rudder/doc/SPEC-implementation.md",
      description: "Implementation contract",
    }).returning().then((rows) => rows[0]!);

    const created = await projectSvc.create(orgId, {
      name: "Resourceful Project",
      status: "planned",
      resourceAttachments: [
        {
          resourceId: existingResource.id,
          role: "reference",
          note: "Read first",
          sortOrder: 0,
        },
      ],
      newResources: [
        {
          name: "Main repo",
          kind: "directory",
          locator: "~/projects/rudder",
          description: "Monorepo checkout",
          role: "working_set",
          note: "Primary implementation surface",
          sortOrder: 1,
        },
      ],
    });

    expect(created.resources).toHaveLength(2);
    expect(created.resources[0]).toEqual(expect.objectContaining({
      role: "reference",
      note: "Read first",
      resource: expect.objectContaining({
        id: existingResource.id,
        name: "Existing spec",
      }),
    }));
    expect(created.resources[1]).toEqual(expect.objectContaining({
      role: "working_set",
      note: "Primary implementation surface",
      resource: expect.objectContaining({
        name: "Main repo",
        kind: "directory",
        locator: "~/projects/rudder",
      }),
    }));

    const persistedOrgResources = await db
      .select({ name: organizationResources.name })
      .from(organizationResources)
      .where(eq(organizationResources.orgId, orgId));
    expect(persistedOrgResources.map((resource) => resource.name).sort()).toEqual(["Existing spec", "Main repo"]);

    const persistedAttachments = await db
      .select({ resourceId: projectResourceAttachments.resourceId, role: projectResourceAttachments.role })
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.projectId, created.id));
    expect(persistedAttachments).toHaveLength(2);
  });
});
