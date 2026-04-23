import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockResourceCatalogService = vi.hoisted(() => ({
  createProjectResourceAttachment: vi.fn(),
  updateProjectResourceAttachment: vi.fn(),
  removeProjectResourceAttachment: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  resourceCatalogService: () => mockResourceCatalogService,
  logActivity: mockLogActivity,
}));

function createProject() {
  const now = new Date("2026-04-16T09:00:00.000Z");
  return {
    id: "project-1",
    orgId: "organization-1",
    urlKey: "control-plane",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Control Plane",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#60a5fa",
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      configured: false,
      scope: "none",
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/rudder/organizations/organization-1/codebases/default",
      effectiveLocalFolder: "/tmp/rudder/organizations/organization-1/codebases/default",
      origin: "managed_checkout",
    },
    resources: [],
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/orgs/:orgId/projects", () => {
  beforeEach(() => {
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockLogActivity.mockReset();
    mockProjectService.resolveByReference.mockResolvedValue({ project: null, ambiguous: false });
    mockResourceCatalogService.createProjectResourceAttachment.mockReset();
    mockResourceCatalogService.updateProjectResourceAttachment.mockReset();
    mockResourceCatalogService.removeProjectResourceAttachment.mockReset();
  });

  it("ignores workspace payload from legacy callers", async () => {
    mockProjectService.create.mockResolvedValue(createProject());
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Control Plane",
        status: "planned",
        workspace: {
          cwd: "/tmp/legacy-project-workspace",
          repoUrl: "https://github.com/acme/control-plane",
        },
      });

    expect(res.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith("organization-1", {
      name: "Control Plane",
      status: "planned",
    });
    expect(res.body.workspaces).toEqual([]);
    expect(res.body.primaryWorkspace).toBeNull();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "project.created",
        entityType: "project",
        entityId: "project-1",
      }),
    );
  });

  it("attaches a project resource through the dedicated resource route", async () => {
    const project = createProject();
    mockProjectService.getById.mockResolvedValue(project);
    mockResourceCatalogService.createProjectResourceAttachment.mockResolvedValue({
      id: "attachment-1",
      orgId: "organization-1",
      projectId: "project-1",
      resourceId: "11111111-1111-4111-8111-111111111111",
      role: "reference",
      note: "Read before editing",
      sortOrder: 0,
      resource: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: "organization-1",
        name: "Rudder repo",
        kind: "directory",
        locator: "~/projects/rudder",
        description: "Main repository",
        metadata: null,
        createdAt: new Date("2026-04-16T09:00:00.000Z"),
        updatedAt: new Date("2026-04-16T09:00:00.000Z"),
      },
      createdAt: new Date("2026-04-16T09:00:00.000Z"),
      updatedAt: new Date("2026-04-16T09:00:00.000Z"),
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/projects/project-1/resources")
      .send({
        resourceId: "11111111-1111-4111-8111-111111111111",
        role: "reference",
        note: "Read before editing",
      });

    expect(res.status).toBe(201);
    expect(mockResourceCatalogService.createProjectResourceAttachment).toHaveBeenCalledWith("project-1", {
      resourceId: "11111111-1111-4111-8111-111111111111",
      role: "reference",
      note: "Read before editing",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "project.resource.attached",
        entityType: "project_resource_attachment",
        entityId: "attachment-1",
      }),
    );
  });
});
