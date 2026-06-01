import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  agents,
  createDb,
  ensurePostgresDatabase,
  goals,
  organizations,
  organizationResources,
  projectResourceAttachments,
  projectWorkspaces,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { projectService } from "../services/projects.js";
import { resolveOrganizationWorkspaceRoot, resolveProjectLibraryDir } from "../home-paths.js";

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
    await db.delete(goals);
    await db.delete(agents);
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
    const projectLibraryDir = resolveProjectLibraryDir({
      orgId,
      projectId: created.id,
      projectName: created.name,
    });
    expect(fs.existsSync(projectLibraryDir)).toBe(true);
    expect(fs.readFileSync(path.join(projectLibraryDir, "README.md"), "utf8")).toContain(
      "Agents should keep durable project work files inside this folder.",
    );

    const persistedWorkspaces = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, created.id));
    expect(persistedWorkspaces).toEqual([]);
  });

  it("repairs missing project Library folders when projects are listed", async () => {
    const rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-projects-repair-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Repair Workspace Org",
      urlKey: deriveOrganizationUrlKey("Repair Workspace Org"),
      issuePrefix: "RWO",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await projectSvc.create(orgId, {
      name: "Repairable Project",
      status: "planned",
    });
    const projectLibraryDir = resolveProjectLibraryDir({
      orgId,
      projectId: created.id,
      projectName: created.name,
    });
    fs.rmSync(projectLibraryDir, { recursive: true, force: true });
    expect(fs.existsSync(projectLibraryDir)).toBe(false);

    await projectSvc.list(orgId);

    expect(fs.existsSync(path.join(projectLibraryDir, "README.md"))).toBe(true);
  });

  it("creates the current project Library folder after a project rename", async () => {
    const rudderHome = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-projects-rename-home-"));
    cleanupDirs.add(rudderHome);
    process.env.RUDDER_HOME = rudderHome;
    process.env.RUDDER_INSTANCE_ID = "test-instance";
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Rename Workspace Org",
      urlKey: deriveOrganizationUrlKey("Rename Workspace Org"),
      issuePrefix: "NWO",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await projectSvc.create(orgId, {
      name: "Original Project",
      status: "planned",
    });
    const updated = await projectSvc.update(created.id, {
      name: "Renamed Project",
    });

    expect(updated?.name).toBe("Renamed Project");
    const renamedProjectLibraryDir = resolveProjectLibraryDir({
      orgId,
      projectId: created.id,
      projectName: "Renamed Project",
    });
    expect(fs.existsSync(path.join(renamedProjectLibraryDir, "README.md"))).toBe(true);
  });

  it("rejects creating a project with goals from another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Project Org",
        urlKey: deriveOrganizationUrlKey("Project Org"),
        issuePrefix: "PRO",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Project Org",
        urlKey: deriveOrganizationUrlKey("Other Project Org"),
        issuePrefix: "OPO",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const otherGoal = await db.insert(goals).values({
      orgId: otherOrgId,
      title: "Other org goal",
    }).returning().then((rows) => rows[0]!);

    await expect(projectSvc.create(orgId, {
      name: "Cross Org Project",
      status: "planned",
      goalIds: [otherGoal.id],
    })).rejects.toMatchObject({
      status: 422,
      message: "Goals must belong to same organization",
    });
  });

  it("treats explicit empty goalIds as authoritative over a legacy goalId on create", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Explicit Empty Goals Org",
        urlKey: deriveOrganizationUrlKey("Explicit Empty Goals Org"),
        issuePrefix: "EEG",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Explicit Empty Goals Org",
        urlKey: deriveOrganizationUrlKey("Other Explicit Empty Goals Org"),
        issuePrefix: "OEG",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const otherGoal = await db.insert(goals).values({
      orgId: otherOrgId,
      title: "Other org legacy goal",
    }).returning().then((rows) => rows[0]!);

    const created = await projectSvc.create(orgId, {
      name: "Explicit Empty Goal Project",
      status: "planned",
      goalId: otherGoal.id,
      goalIds: [],
    });

    expect(created.goalId).toBeNull();
    expect(created.goalIds).toEqual([]);
    expect(created.goals).toEqual([]);
  });

  it("rejects updating a project with goals from another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Project Goal Update Org",
        urlKey: deriveOrganizationUrlKey("Project Goal Update Org"),
        issuePrefix: "PGU",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Goal Update Org",
        urlKey: deriveOrganizationUrlKey("Other Goal Update Org"),
        issuePrefix: "OGU",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const project = await projectSvc.create(orgId, {
      name: "Goal Update Project",
      status: "planned",
    });
    const otherGoal = await db.insert(goals).values({
      orgId: otherOrgId,
      title: "Other org update goal",
    }).returning().then((rows) => rows[0]!);

    await expect(projectSvc.update(project.id, {
      goalIds: [otherGoal.id],
    })).rejects.toMatchObject({
      status: 422,
      message: "Goals must belong to same organization",
    });
  });

  it("rejects creating a project with a lead agent from another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Lead Agent Create Org",
        urlKey: deriveOrganizationUrlKey("Lead Agent Create Org"),
        issuePrefix: "LAC",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Lead Agent Create Org",
        urlKey: deriveOrganizationUrlKey("Other Lead Agent Create Org"),
        issuePrefix: "OLC",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const otherAgent = await db.insert(agents).values({
      orgId: otherOrgId,
      name: "Other Agent",
      role: "engineer",
    }).returning().then((rows) => rows[0]!);

    await expect(projectSvc.create(orgId, {
      name: "Cross Org Lead Project",
      status: "planned",
      leadAgentId: otherAgent.id,
    })).rejects.toMatchObject({
      status: 422,
      message: "Lead agent must belong to same organization",
    });
  });

  it("rejects updating a project with a lead agent from another organization", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Lead Agent Project Org",
        urlKey: deriveOrganizationUrlKey("Lead Agent Project Org"),
        issuePrefix: "LAP",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Lead Agent Org",
        urlKey: deriveOrganizationUrlKey("Other Lead Agent Org"),
        issuePrefix: "OLA",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    const project = await projectSvc.create(orgId, {
      name: "Owned Project",
      status: "planned",
    });
    const otherAgent = await db.insert(agents).values({
      orgId: otherOrgId,
      name: "Other Agent",
      role: "engineer",
    }).returning().then((rows) => rows[0]!);

    await expect(projectSvc.update(project.id, {
      leadAgentId: otherAgent.id,
    })).rejects.toMatchObject({
      status: 422,
      message: "Lead agent must belong to same organization",
    });
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
      sourceType: "library",
      locator: "docs/SPEC-implementation.md",
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
          sourceType: "external",
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
        sourceType: "library",
      }),
    }));
    expect(created.resources[1]).toEqual(expect.objectContaining({
      role: "working_set",
      note: "Primary implementation surface",
      resource: expect.objectContaining({
        name: "Main repo",
        kind: "directory",
        sourceType: "external",
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

  it("reuses existing library resources when inline project resources target the same path", async () => {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Reusable Resource Org",
      urlKey: deriveOrganizationUrlKey("Reusable Resource Org"),
      issuePrefix: "RRO",
      requireBoardApprovalForNewAgents: false,
    });

    const existingResource = await db.insert(organizationResources).values({
      orgId,
      name: "Existing spec",
      kind: "file",
      sourceType: "library",
      locator: "docs/spec.md",
    }).returning().then((rows) => rows[0]!);

    const created = await projectSvc.create(orgId, {
      name: "Path Based Context",
      status: "planned",
      newResources: [
        {
          name: "Spec copy",
          kind: "file",
          sourceType: "library",
          locator: "docs/spec.md",
          role: "reference",
        },
      ],
    });

    expect(created.resources).toHaveLength(1);
    expect(created.resources[0]?.resourceId).toBe(existingResource.id);

    const persistedOrgResources = await db
      .select({ id: organizationResources.id })
      .from(organizationResources)
      .where(eq(organizationResources.orgId, orgId));
    expect(persistedOrgResources).toHaveLength(1);
  });
});
