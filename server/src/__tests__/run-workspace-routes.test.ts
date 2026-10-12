import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runWorkspaceRoutes } from "../routes/execution-workspaces.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockRunWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));
const activeServers = new Set<Server>();
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  runWorkspaceService: () => mockRunWorkspaceService,
  workspaceOperationService: () => ({
    createRecorder: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

async function createApp(rustFoundation?: RustFoundationBridge) {
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
  app.use("/api", runWorkspaceRoutes({} as any, rustFoundation));
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

  for (const alias of ["run-workspaces", "execution-workspaces"]) {
    it(`${alias} dispatches ordinary updates to Rust before any Node target access`, async () => {
      const runWorkspaceOrdinaryUpdate = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from('{"id":"workspace-1","status":"idle"}') });
      const res = await request(await createApp({ runWorkspaceOrdinaryUpdate } as unknown as RustFoundationBridge))
        .patch(`/api/${alias}/workspace-1`).send({ status: "idle" });
      expect(res.status).toBe(200);
      expect(runWorkspaceOrdinaryUpdate).toHaveBeenCalledWith(expect.objectContaining({ type: "board" }), { id: "workspace-1", input: { status: "idle" } });
      expect(mockRunWorkspaceService.getById).not.toHaveBeenCalled();
      expect(mockRunWorkspaceService.update).not.toHaveBeenCalled();
    });

    it(`${alias} validates before dispatch and never falls back after a native outage`, async () => {
      const runWorkspaceOrdinaryUpdate = vi.fn().mockRejectedValue(new Error("Native unavailable"));
      const app = await createApp({ runWorkspaceOrdinaryUpdate } as unknown as RustFoundationBridge);
      expect((await request(app).patch(`/api/${alias}/missing`).send({ status: "archived", unknown: true })).status).toBe(400);
      expect(runWorkspaceOrdinaryUpdate).not.toHaveBeenCalled();
      expect(mockRunWorkspaceService.getById).not.toHaveBeenCalled();
      expect((await request(app).patch(`/api/${alias}/workspace-1`).send({ cleanupReason: "note" })).status).toBe(503);
      expect(mockRunWorkspaceService.getById).not.toHaveBeenCalled();
      expect(mockRunWorkspaceService.update).not.toHaveBeenCalled();
    });

    it(`${alias} keeps explicit archive requests on Node, including repeats`, async () => {
      const runWorkspaceOrdinaryUpdate = vi.fn().mockRejectedValue(new Error("Native unavailable"));
      const app = await createApp({ runWorkspaceOrdinaryUpdate } as unknown as RustFoundationBridge);
      mockRunWorkspaceService.getById.mockResolvedValueOnce(null);
      expect((await request(app).patch(`/api/${alias}/missing`).send({ status: "archived" })).status).toBe(404);
      const archived = { id: "workspace-1", orgId: "organization-1", status: "archived" };
      mockRunWorkspaceService.getById.mockResolvedValueOnce(archived);
      mockRunWorkspaceService.update.mockResolvedValueOnce(archived);
      expect((await request(app).patch(`/api/${alias}/workspace-1`).send({ status: "archived" })).status).toBe(200);
      expect(mockRunWorkspaceService.update).toHaveBeenCalledWith("workspace-1", { status: "archived" });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "run_workspace.updated", details: { changedKeys: ["status"] } }));
      expect(runWorkspaceOrdinaryUpdate).not.toHaveBeenCalled();
    });
  }
});
