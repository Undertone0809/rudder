import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockRunWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  runWorkspaceService: () => mockRunWorkspaceService,
  workspaceOperationService: () => ({
    createRecorder: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

function createApp() {
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
  app.use("/api", runWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("run workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
