import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { lockNodeProjectGoalMutationAuthority } from "../services/project-goal-mutation-fence.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

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
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: mockLogActivity,
}));

function createProject() {
  const now = new Date("2026-04-16T09:00:00.000Z");
  return {
    id: "project-1",
    orgId: "organization-1",
    urlKey: "Rudder",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Rudder",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#60a5fa",
    icon: "folder",
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

const activeServers = new Set<Server>();

async function createApp(actor: Record<string, unknown>, rustFoundationBridge?: RustFoundationBridge) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any, rustFoundationBridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("POST /api/orgs/:orgId/projects", () => {
  beforeEach(() => {
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.update.mockReset();
    mockLogActivity.mockReset();
    mockProjectService.resolveByReference.mockResolvedValue({ project: null, ambiguous: false });
    mockResourceCatalogService.createProjectResourceAttachment.mockReset();
    mockResourceCatalogService.updateProjectResourceAttachment.mockReset();
    mockResourceCatalogService.removeProjectResourceAttachment.mockReset();
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("ignores workspace payload from legacy callers", async () => {
    mockProjectService.create.mockResolvedValue(createProject());
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Rudder",
        status: "planned",
        workspace: {
          cwd: "/tmp/legacy-project-workspace",
          repoUrl: "https://github.com/acme/Rudder",
        },
      });

    expect(res.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith("organization-1", {
      name: "Rudder",
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

  it("allows authenticated agents to create projects in their organization", async () => {
    mockProjectService.create.mockResolvedValue(createProject());
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Rudder",
        status: "planned",
      });

    expect(res.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith("organization-1", {
      name: "Rudder",
      status: "planned",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "project.created",
      }),
    );
  });

  it("keeps create-with-goals atomic before handing the new Project-Goal fence to Rust", async () => {
    const created = {
      ...createProject(),
      goalId: "11111111-1111-4111-8111-111111111111",
      goalIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    };
    mockProjectService.create.mockResolvedValue(created);
    const rustFoundationBridge = {
      projectGoalSetMode: "required",
    } as unknown as RustFoundationBridge;
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustFoundationBridge);

    const res = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Rudder with goals",
        goalIds: created.goalIds,
      });

    expect(res.status).toBe(201);
    expect(res.body.goalIds).toEqual(created.goalIds);
    expect(mockProjectService.create).toHaveBeenCalledWith(
      "organization-1",
      { name: "Rudder with goals", status: "backlog", goalIds: created.goalIds },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "project.created",
        entityId: created.id,
      }),
    );
  });

  it("passes project icon tokens through create and update payload validation", async () => {
    mockProjectService.create.mockResolvedValue({ ...createProject(), icon: "plane" });
    mockProjectService.getById.mockResolvedValue({ ...createProject(), icon: "plane" });
    mockProjectService.update.mockResolvedValue({ ...createProject(), icon: "book" });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const created = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Travel Ops",
        icon: "plane",
      });

    expect(created.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledWith("organization-1", {
      name: "Travel Ops",
      icon: "plane",
      status: "backlog",
    });

    const updated = await request(app)
      .patch("/api/projects/project-1")
      .send({
        icon: "book",
      });

    expect(updated.status).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", {
      icon: "book",
    });
  });

  it("rejects agent project creation outside the authenticated organization", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-2",
      source: "agent_key",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/projects")
      .send({
        name: "Rudder",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another organization");
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("rejects agent project reads outside the authenticated organization", async () => {
    mockProjectService.getById.mockResolvedValue({
      ...createProject(),
      orgId: "organization-1",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-2",
      source: "agent_key",
    });

    const res = await request(app).get("/api/projects/project-1");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another organization");
  });

  it("rejects agent project updates outside the authenticated organization", async () => {
    mockProjectService.getById.mockResolvedValue({
      ...createProject(),
      orgId: "organization-1",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-2",
      source: "agent_key",
    });

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        status: "in_progress",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another organization");
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("routes a pure goal-set replacement to Rust and does not duplicate Node activity", async () => {
    const existing = createProject();
    const updated = {
      ...existing,
      goalId: "11111111-1111-4111-8111-111111111111",
      goalIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    };
    mockProjectService.getById
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated);
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ result: { kind: "project_goal_set_replacement" } })),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, bridge);

    const res = await request(app)
      .patch("/api/projects/project-1")
      .set("x-rudder-idempotency-key", "project-goal-route-1")
      .send({
        goalIds: updated.goalIds,
      });

    expect(res.status).toBe(200);
    expect(res.body.goalIds).toEqual(updated.goalIds);
    expect(bridge.projectGoalSet).toHaveBeenCalledWith(
      expect.objectContaining({ originalUrl: "/api/projects/project-1" }),
      "organization-1",
      "project-1",
      expect.any(Buffer),
      "/api/orgs/organization-1/projects/project-1/goal-set",
    );
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody).toEqual({
      goalIds: updated.goalIds,
      primaryGoalId: updated.goalIds[0],
      runId: null,
    });
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("preserves an explicit empty goalIds array for Rust clear-all", async () => {
    const existing = createProject();
    mockProjectService.getById
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce({ ...existing, goalId: null, goalIds: [] });
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from("{}"),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch("/api/projects/project-1")
      .set("x-rudder-idempotency-key", "project-goal-clear-1")
      .send({ goalIds: [] });

    expect(res.status).toBe(200);
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody).toEqual({ goalIds: [], primaryGoalId: null, runId: null });
  });

  it("requires an idempotency key before entering the Rust Project-Goal bridge", async () => {
    mockProjectService.getById.mockResolvedValue(createProject());
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ goalIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("idempotency-key");
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
  });

  it("fails closed for a mixed Project and Project-Goal update", async () => {
    mockProjectService.getById.mockResolvedValue(createProject());
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        goalIds: [],
        name: "Project renamed separately",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("separate requests");
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("rejects a legacy Project delete after Rust owns the Project-Goal fence", async () => {
    const existing = createProject();
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.remove.mockReset();
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        owner: "node",
        mutation_version: "0",
        fence_epoch: "0",
        fence_token: "11111111-1111-4111-8111-111111111111",
      }])
      .mockResolvedValueOnce([{
        project_id: existing.id,
        org_id: existing.orgId,
        mutation_version: "4",
        fence_epoch: "1",
        fence_token: "22222222-2222-4222-8222-222222222222",
        owner: "rust",
      }]);
    const deleteBusinessRow = vi.fn();
    mockProjectService.remove.mockImplementation(async (id: string) => {
      await lockNodeProjectGoalMutationAuthority({ execute }, existing.orgId, id);
      deleteBusinessRow();
      return existing;
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/projects/project-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Project goal mutation authority is owned by Rust");
    expect(mockProjectService.remove).toHaveBeenCalledWith("project-1");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(deleteBusinessRow).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
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
      isPrimary: true,
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

    const app = await createApp({
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
        isPrimary: true,
      });

    expect(res.status).toBe(201);
    expect(mockResourceCatalogService.createProjectResourceAttachment).toHaveBeenCalledWith("project-1", {
      resourceId: "11111111-1111-4111-8111-111111111111",
      role: "reference",
      note: "Read before editing",
      isPrimary: true,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "project.resource.attached",
        entityType: "project_resource_attachment",
        entityId: "attachment-1",
        details: {
          projectId: "project-1",
          resourceId: "11111111-1111-4111-8111-111111111111",
          role: "reference",
          isPrimary: true,
        },
      }),
    );
  });
});
