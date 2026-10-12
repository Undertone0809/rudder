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
const mockWorkspaceIdentity = vi.hoisted(() => vi.fn());
const mockDateContext = vi.hoisted(() => vi.fn());

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
  const db = {
    execute: mockDateContext,
    select: () => ({ from: () => ({ where: mockWorkspaceIdentity }) }),
  };
  app.use("/api", runWorkspaceRoutes(db as any, rustFoundation));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("run workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceIdentity.mockReset().mockResolvedValue([]);
    mockDateContext.mockReset().mockResolvedValue([{ timezone: "UTC" }]);
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("serves the canonical run workspace list route", async () => {
    const workspaces = [{ id: "workspace-1", orgId: "organization-1" }];
    const runWorkspaceRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(workspaces)) });

    const res = await request(await createApp({ runWorkspaceRead } as unknown as RustFoundationBridge)).get("/api/orgs/organization-1/run-workspaces");

    expect(res.status).toBe(200);
    expect(runWorkspaceRead).toHaveBeenCalledWith(expect.objectContaining({ type: "board", userId: "user-1" }), "organization-1", {
      operation: "list",
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      statuses: undefined,
      reuseEligible: false,
      legacyDateTimezone: "UTC",
    });
    expect(res.body).toEqual([{ id: "workspace-1", orgId: "organization-1" }]);
    expect(mockRunWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("keeps the legacy execution workspace list route as an alias", async () => {
    const runWorkspaceRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });

    const res = await request(await createApp({ runWorkspaceRead } as unknown as RustFoundationBridge)).get("/api/orgs/organization-1/execution-workspaces");

    expect(res.status).toBe(200);
    expect(runWorkspaceRead).toHaveBeenCalledOnce();
    expect(runWorkspaceRead).toHaveBeenCalledWith(expect.objectContaining({ type: "board" }), "organization-1", expect.objectContaining({ operation: "list", legacyDateTimezone: "UTC" }));
    expect(res.body).toEqual([]);
    expect(mockRunWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("uses run workspace wording on canonical detail errors", async () => {
    mockWorkspaceIdentity.mockResolvedValue([]);

    const res = await request(await createApp()).get("/api/run-workspaces/missing-workspace");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Run workspace not found" });
    expect(mockRunWorkspaceService.getById).not.toHaveBeenCalled();
  });

  for (const alias of ["run-workspaces", "execution-workspaces"]) {
    it(`${alias} sends canonical detail identity to Rust and preserves missing-target wording`, async () => {
      const workspace = { id: "workspace-1", orgId: "organization-1", status: "idle" };
      const runWorkspaceRead = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(workspace)) });
      const app = await createApp({ runWorkspaceRead } as unknown as RustFoundationBridge);
      mockWorkspaceIdentity.mockResolvedValueOnce([{ id: workspace.id, orgId: workspace.orgId }]);
      const found = await request(app).get(`/api/${alias}/workspace-1`);
      expect(found.status).toBe(200);
      expect(found.body).toEqual(workspace);
      expect(runWorkspaceRead).toHaveBeenCalledWith(expect.objectContaining({ type: "board" }), workspace.orgId, { operation: "detail", workspaceId: workspace.id, legacyDateTimezone: "UTC" });
      const missing = await request(app).get(`/api/${alias}/missing-workspace`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "Run workspace not found" });
      expect(runWorkspaceRead).toHaveBeenCalledOnce();
      expect(mockRunWorkspaceService.getById).not.toHaveBeenCalled();
    });

    it(`${alias} does not fall back to Node when Rust reads are unavailable`, async () => {
      const missingBridge = await request(await createApp()).get(`/api/orgs/organization-1/${alias}`);
      expect(missingBridge.status).toBe(503);
      const runWorkspaceRead = vi.fn().mockRejectedValue(new Error("Native unavailable"));
      const unavailable = await request(await createApp({ runWorkspaceRead } as unknown as RustFoundationBridge)).get(`/api/orgs/organization-1/${alias}`);
      expect(unavailable.status).toBe(503);
      expect(runWorkspaceRead).toHaveBeenCalledOnce();
      expect(mockRunWorkspaceService.list).not.toHaveBeenCalled();
    });

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
