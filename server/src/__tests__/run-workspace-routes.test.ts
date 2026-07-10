import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { runWorkspaceService } from "../services/execution-workspaces.js";

const mockRunWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceRuntime = vi.hoisted(() => ({
  cleanupExecutionWorkspaceArtifacts: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  runWorkspaceService: () => mockRunWorkspaceService,
  workspaceOperationService: () => ({
    createRecorder: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

vi.mock("../services/workspace-runtime.js", () => mockWorkspaceRuntime);

function createApp(db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", runWorkspaceRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("run workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRuntime.cleanupExecutionWorkspaceArtifacts.mockResolvedValue({
      cleaned: true,
      warnings: [],
    });
    mockWorkspaceRuntime.stopRuntimeServicesForExecutionWorkspace.mockResolvedValue(undefined);
  });

  it("serves the canonical run workspace list route", async () => {
    mockRunWorkspaceService.list.mockResolvedValue([{ id: "workspace-1", orgId: "organization-1" }]);

    const res = await request(createApp()).get("/api/orgs/organization-1/run-workspaces");

    expect(res.status).toBe(200);
    expect(mockRunWorkspaceService.list).toHaveBeenCalledWith("organization-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: false,
    });
    expect(res.body).toEqual([{ id: "workspace-1", orgId: "organization-1" }]);
  });

  it("keeps the legacy execution workspace list route as an alias", async () => {
    mockRunWorkspaceService.list.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/orgs/organization-1/execution-workspaces");

    expect(res.status).toBe(200);
    expect(mockRunWorkspaceService.list).toHaveBeenCalledOnce();
  });

  it("uses run workspace wording on canonical detail errors", async () => {
    mockRunWorkspaceService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/run-workspaces/missing-workspace");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run workspace not found" });
  });

  it("blocks the two-step runtime provenance forgery before an archive cleanup", async () => {
    const existing = {
      id: "workspace-1",
      orgId: "organization-1",
      projectId: "project-1",
      projectWorkspaceId: null,
      sourceIssueId: null,
      status: "active",
      cwd: "/tmp/shared-organization-workspace",
      providerType: "local_fs",
      providerRef: null,
      branchName: null,
      repoUrl: null,
      baseRef: null,
      metadata: { source: "project_primary", createdByRuntime: false },
    };
    mockRunWorkspaceService.getById.mockResolvedValue(existing);
    mockRunWorkspaceService.update.mockImplementation(async (_id, patch) => ({
      ...existing,
      ...patch,
    }));
    const selectWhere = vi.fn(async () => []);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: selectWhere })),
      })),
    };
    const app = createApp(db);

    const forged = await request(app)
      .patch("/api/run-workspaces/workspace-1")
      .send({ metadata: { createdByRuntime: true, source: "runtime" } });
    expect(forged.status).toBe(400);
    expect(mockRunWorkspaceService.update).not.toHaveBeenCalled();

    const archived = await request(app)
      .patch("/api/run-workspaces/workspace-1")
      .send({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(mockWorkspaceRuntime.cleanupExecutionWorkspaceArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: expect.objectContaining({
          metadata: { source: "project_primary", createdByRuntime: false },
        }),
      }),
    );
  });

  it("rejects runtime metadata updates in the service unless an internal caller opts in", async () => {
    const update = vi.fn();
    const svc = runWorkspaceService({ update } as any);

    await expect(svc.update("workspace-1", {
      metadata: { createdByRuntime: true, source: "runtime" },
    })).rejects.toMatchObject({
      status: 422,
      message: "Run workspace runtime metadata is managed internally",
    });
    expect(update).not.toHaveBeenCalled();
  });
});
