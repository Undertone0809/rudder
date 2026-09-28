import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { lockProjectGoalMutationAuthorityForDelete } from "../services/project-goal-mutation-fence.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getMutationOwner: vi.fn(),
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
const RUST_OWNED_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const originalProjectGoalProjectIds = process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS;

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

function createProject(id = "project-1") {
  const now = new Date("2026-04-16T09:00:00.000Z");
  return {
    id,
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

async function createApp(
  actor: Record<string, unknown>,
  rustFoundationBridge?: RustFoundationBridge,
  db: Record<string, unknown> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db as any, rustFoundationBridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

function createReceiptDb(...responses: Array<{ status: number; body: unknown }>) {
  const execute = vi.fn();
  for (const response of responses) {
    execute.mockResolvedValueOnce([{ resource_attachment_response: response }]);
  }
  return { execute };
}

describe("POST /api/orgs/:orgId/projects", () => {
  beforeEach(() => {
    process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = RUST_OWNED_PROJECT_ID;
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.getMutationOwner.mockReset().mockResolvedValue("node");
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
    if (originalProjectGoalProjectIds === undefined) {
      delete process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS;
    } else {
      process.env.RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS = originalProjectGoalProjectIds;
    }
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
    const existing = createProject(RUST_OWNED_PROJECT_ID);
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
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
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
      .patch(`/api/projects/${existing.id}`)
      .set("x-rudder-idempotency-key", "project-goal-route-1")
      .send({
        goalIds: updated.goalIds,
      });

    expect(res.status).toBe(200);
    expect(res.body.goalIds).toEqual(updated.goalIds);
    expect(bridge.projectGoalSet).toHaveBeenCalledWith(
      expect.objectContaining({ originalUrl: `/api/projects/${existing.id}` }),
      existing.orgId,
      existing.id,
      expect.any(Buffer),
      `/api/orgs/${existing.orgId}/projects/${existing.id}/goal-set`,
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

  it("keeps a Node-owned Project usable in required mode, even when it is allowlisted", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    const updated = { ...existing, goalId: null, goalIds: [] };
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.update.mockResolvedValue(updated);
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch(`/api/projects/${existing.id}`)
      .send({ goalIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.goalIds).toEqual([]);
    expect(mockProjectService.update).toHaveBeenCalledWith(existing.id, { goalIds: [] });
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.updated", entityId: existing.id }),
    );
  });

  it("fails closed when a caller explicitly requires Rust outside the project allowlist", async () => {
    const existing = createProject();
    mockProjectService.getById.mockResolvedValue(existing);
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch(`/api/projects/${existing.id}`)
      .set("x-rudder-required-authority", "rust")
      .set("x-rudder-idempotency-key", "unallowlisted-rust-project-goal")
      .send({ goalIds: [] });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rust_foundation_project_goal_set_not_allowlisted");
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
  });

  it("preserves an explicit empty goalIds array for Rust clear-all", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
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
      .patch(`/api/projects/${existing.id}`)
      .set("x-rudder-idempotency-key", "project-goal-clear-1")
      .send({ goalIds: [] });

    expect(res.status).toBe(200);
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody).toEqual({ goalIds: [], primaryGoalId: null, runId: null });
  });

  it("requires an idempotency key before entering the Rust Project-Goal bridge", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch(`/api/projects/${existing.id}`)
      .send({ goalIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("idempotency-key");
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
  });

  it("routes a mixed Project and Project-Goal patch to Rust without splitting its fields", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    const updated = { ...existing, name: "Renamed project", goalIds: [] };
    mockProjectService.getById.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ result: { kind: "project_patch" } })),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const projectPatch = {
      goalIds: [],
      name: "Renamed project",
      description: "Updated through the Rust transaction",
      status: "planned",
      leadAgentId: null,
      targetDate: "2026-10-01",
      color: "#123abc",
      icon: "folder",
      executionWorkspacePolicy: null,
      resourceAttachments: [{
        resourceId: "40000000-0000-4000-8000-000000000001",
        role: "reference",
        note: "Design source",
        sortOrder: 3,
        isPrimary: true,
      }],
      newResources: [{
        name: "Inline brief",
        kind: "file",
        locator: "https://example.test/brief.md",
        role: "deliverable",
        note: "Current brief",
        sortOrder: 4,
        isPrimary: false,
      }],
      archivedAt: null,
    };
    const res = await request(app)
      .patch(`/api/projects/${existing.id}`)
      .set("x-rudder-idempotency-key", "project-mixed-patch-1")
      .send({
        ...projectPatch,
      });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(updated.name);
    expect(bridge.projectGoalSet).toHaveBeenCalledWith(
      expect.objectContaining({ originalUrl: `/api/projects/${existing.id}` }),
      existing.orgId,
      existing.id,
      expect.any(Buffer),
      `/api/orgs/${existing.orgId}/projects/${existing.id}/goal-set`,
    );
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody).toEqual({ projectPatch: { ...projectPatch, newResources: [{
      ...projectPatch.newResources[0],
      sourceType: "external",
    }] }, runId: null });
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("routes scalar Project patches through Rust after the Project owner handoff", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    const updated = { ...existing, name: "Rust-owned scalar update" };
    mockProjectService.getById.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ result: { kind: "project_patch" } })),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .patch(`/api/projects/${existing.id}`)
      .set("x-rudder-idempotency-key", "project-scalar-patch-1")
      .send({ name: updated.name });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(updated.name);
    expect(bridge.projectGoalSet).toHaveBeenCalledOnce();
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody).toEqual({ projectPatch: { name: updated.name }, runId: null });
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("fails closed instead of sending a Rust-owned scalar patch to Node", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    const res = await request(app).patch(`/api/projects/${existing.id}`).send({ name: "Stale Node write" });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rust_foundation_project_goal_set_disabled");
    expect(mockProjectService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("serializes deletion of a Rust-owned Project-Goal row before cascading its authority", async () => {
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
      await lockProjectGoalMutationAuthorityForDelete({ execute }, existing.orgId, id);
      deleteBusinessRow();
      return existing;
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).delete("/api/projects/project-1");

    expect(res.status).toBe(200);
    expect(mockProjectService.remove).toHaveBeenCalledWith("project-1");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(deleteBusinessRow).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project.deleted", entityId: existing.id }),
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

  it("forwards Rust-owned project resource attachment writes without a Node writer or duplicate activity", async () => {
    const project = createProject(RUST_OWNED_PROJECT_ID);
    const attachment = {
      id: "attachment-1",
      orgId: project.orgId,
      projectId: project.id,
      resourceId: "11111111-1111-4111-8111-111111111111",
      role: "reference",
      note: "Read before editing",
      sortOrder: 0,
      isPrimary: true,
      resource: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: project.orgId,
        name: "Rudder repo",
        kind: "directory",
        sourceType: "external",
        locator: "~/projects/rudder",
        description: "Main repository",
        metadata: null,
        createdAt: new Date("2026-04-16T09:00:00.000Z"),
        updatedAt: new Date("2026-04-16T09:00:00.000Z"),
      },
      createdAt: new Date("2026-04-16T09:00:00.000Z"),
      updatedAt: new Date("2026-04-16T09:00:00.000Z"),
    };
    mockProjectService.getById
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce({ ...project, resources: [attachment] })
      .mockResolvedValueOnce({ ...project, resources: [] });
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const receiptDb = createReceiptDb(
      { status: 201, body: attachment },
      { status: 200, body: attachment },
      { status: 201, body: attachment },
    );
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ result: { kind: "project_patch" } })),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp(
      { type: "board", userId: "user-1", source: "local_implicit" },
      bridge,
      receiptDb,
    );

    const res = await request(app)
      .post(`/api/projects/${project.id}/resources`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-attach")
      .send({
        resourceId: attachment.resourceId,
        role: "reference",
        note: "Read before editing",
        isPrimary: true,
      });
    const remove = await request(app)
      .delete(`/api/projects/${project.id}/resources/${attachment.id}`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-remove");
    const replay = await request(app)
      .post(`/api/projects/${project.id}/resources`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-attach")
      .send({
        resourceId: attachment.resourceId,
        role: "reference",
        note: "Read before editing",
        isPrimary: true,
      });

    expect(res.status).toBe(201);
    expect(remove.status).toBe(200);
    expect(remove.body).toMatchObject({
      id: attachment.id,
      resourceId: attachment.resourceId,
      note: "Read before editing",
    });
    expect(replay.status).toBe(res.status);
    expect(replay.body).toEqual(res.body);
    expect(res.body).toMatchObject({
      id: attachment.id,
      orgId: project.orgId,
      projectId: project.id,
      resourceId: attachment.resourceId,
      role: "reference",
      note: "Read before editing",
      sortOrder: 0,
      isPrimary: true,
      resource: {
        id: attachment.resource.id,
        orgId: project.orgId,
        name: "Rudder repo",
        kind: "directory",
        sourceType: "external",
        locator: "~/projects/rudder",
        description: "Main repository",
        metadata: null,
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(bridge.projectGoalSet).toHaveBeenCalledTimes(3);
    expect(receiptDb.execute).toHaveBeenCalledTimes(3);
    const rustBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    expect(rustBody.projectPatch).toEqual({
      resourceAttachmentOperation: {
        kind: "attach",
        resourceId: attachment.resourceId,
        role: "reference",
        note: "Read before editing",
        isPrimary: true,
      },
    });
    const removeBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[1][3].toString("utf8"));
    expect(removeBody.projectPatch.resourceAttachmentOperation).toEqual({
      kind: "remove",
      attachmentId: attachment.id,
    });
    expect((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[2][0].header("x-rudder-idempotency-key"))
      .toBe("rust-owned-resource-attach");
    expect(mockResourceCatalogService.createProjectResourceAttachment).not.toHaveBeenCalled();
    expect(mockResourceCatalogService.removeProjectResourceAttachment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("forwards Rust-owned project resource edits and removals through the same transaction authority", async () => {
    const project = createProject(RUST_OWNED_PROJECT_ID);
    const attachment = {
      id: "attachment-1",
      orgId: project.orgId,
      projectId: project.id,
      resourceId: "11111111-1111-4111-8111-111111111111",
      role: "reference",
      note: "Original note",
      sortOrder: 0,
      isPrimary: false,
      resource: {
        id: "11111111-1111-4111-8111-111111111111",
        orgId: project.orgId,
        name: "Repo",
        kind: "directory",
        sourceType: "external",
        locator: "~/projects/rudder",
        description: "Repository",
        metadata: null,
        createdAt: new Date("2026-04-16T09:00:00.000Z"),
        updatedAt: new Date("2026-04-16T09:00:00.000Z"),
      },
      createdAt: new Date("2026-04-16T09:00:00.000Z"),
      updatedAt: new Date("2026-04-16T09:00:00.000Z"),
    };
    const updatedAttachment = { ...attachment, note: "Updated note" };
    mockProjectService.getById
      .mockResolvedValueOnce({ ...project, resources: [attachment] })
      .mockResolvedValueOnce({ ...project, resources: [updatedAttachment] })
      .mockResolvedValueOnce({ ...project, resources: [] })
      .mockResolvedValueOnce({ ...project, resources: [] });
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const receiptDb = createReceiptDb(
      { status: 200, body: updatedAttachment },
      { status: 200, body: attachment },
      { status: 200, body: attachment },
      { status: 200, body: updatedAttachment },
    );
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({
        status: 200,
        contentType: "application/json",
        body: Buffer.from(JSON.stringify({ result: { kind: "project_patch" } })),
      }),
    } as unknown as RustFoundationBridge;
    const app = await createApp(
      { type: "board", userId: "user-1", source: "local_implicit" },
      bridge,
      receiptDb,
    );

    const patchResponse = await request(app)
      .patch(`/api/projects/${project.id}/resources/${attachment.id}`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-update")
      .send({ note: "Updated note" });
    const deleteResponse = await request(app)
      .delete(`/api/projects/${project.id}/resources/${attachment.id}`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-remove");
    const deleteReplayResponse = await request(app)
      .delete(`/api/projects/${project.id}/resources/${attachment.id}`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-remove");
    const updateReplayResponse = await request(app)
      .patch(`/api/projects/${project.id}/resources/${attachment.id}`)
      .set("x-rudder-idempotency-key", "rust-owned-resource-update")
      .send({ note: "Updated note" });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.note).toBe("Updated note");
    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.id).toBe(attachment.id);
    expect(deleteReplayResponse.status).toBe(deleteResponse.status);
    expect(deleteReplayResponse.body).toEqual(deleteResponse.body);
    expect(updateReplayResponse.status).toBe(patchResponse.status);
    expect(updateReplayResponse.body).toEqual(patchResponse.body);
    expect(deleteResponse.body).toMatchObject({
      orgId: project.orgId,
      projectId: project.id,
      resourceId: attachment.resourceId,
      role: "reference",
      note: "Original note",
      sortOrder: 0,
      isPrimary: false,
      resource: {
        id: attachment.resourceId,
        orgId: project.orgId,
        name: "Repo",
        kind: "directory",
        sourceType: "external",
        locator: "~/projects/rudder",
        description: "Repository",
        metadata: null,
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(receiptDb.execute).toHaveBeenCalledTimes(4);
    expect(bridge.projectGoalSet).toHaveBeenCalledTimes(4);
    const patchBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0][3].toString("utf8"));
    const deleteBody = JSON.parse((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[1][3].toString("utf8"));
    expect(patchBody.projectPatch.resourceAttachmentOperation).toEqual({
      kind: "update",
      attachmentId: attachment.id,
      note: "Updated note",
    });
    expect(deleteBody.projectPatch.resourceAttachmentOperation).toEqual({
      kind: "remove",
      attachmentId: attachment.id,
    });
    expect((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[2][0].header("x-rudder-idempotency-key"))
      .toBe("rust-owned-resource-remove");
    expect((bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[3][0].header("x-rudder-idempotency-key"))
      .toBe("rust-owned-resource-update");
    expect(mockResourceCatalogService.updateProjectResourceAttachment).not.toHaveBeenCalled();
    expect(mockResourceCatalogService.removeProjectResourceAttachment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("fails closed for a Rust-owned project resource write without an idempotency key", async () => {
    const existing = createProject(RUST_OWNED_PROJECT_ID);
    mockProjectService.getById.mockResolvedValue(existing);
    mockProjectService.getMutationOwner.mockResolvedValue("rust");
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn(),
    } as unknown as RustFoundationBridge;
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" }, bridge);

    const res = await request(app)
      .post(`/api/projects/${existing.id}/resources`)
      .send({ resourceId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("idempotency-key");
    expect(bridge.projectGoalSet).not.toHaveBeenCalled();
    expect(mockResourceCatalogService.createProjectResourceAttachment).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
