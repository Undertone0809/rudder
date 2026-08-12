import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockRunWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));
const activeServers = new Set<Server>();

vi.mock("../services/index.js", () => ({
  runWorkspaceService: () => mockRunWorkspaceService,
  workspaceOperationService: () => ({
    createRecorder: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

async function createApp() {
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
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("run workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("serves the canonical run workspace list route", async () => {
    mockRunWorkspaceService.list.mockResolvedValue([{ id: "workspace-1", orgId: "organization-1" }]);

    const res = await request(await createApp()).get("/api/orgs/organization-1/run-workspaces");

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

    const res = await request(await createApp()).get("/api/orgs/organization-1/execution-workspaces");

    expect(res.status).toBe(200);
    expect(mockRunWorkspaceService.list).toHaveBeenCalledOnce();
  });

  it("uses run workspace wording on canonical detail errors", async () => {
    mockRunWorkspaceService.getById.mockResolvedValue(null);

    const res = await request(await createApp()).get("/api/run-workspaces/missing-workspace");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run workspace not found" });
  });
});
