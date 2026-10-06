import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";
import type { RustFoundationResponse } from "../services/rust-foundation-bridge.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

// Keep the actual management handlers, authz, and error middleware mounted.
// Only the service registry is replaced to isolate the retained issue lookup.
vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
}));

const orgId = "11111111-1111-4111-8111-111111111111";
const otherOrgId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const goalId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const boardActor: Request["actor"] = {
  type: "board",
  source: "session",
  userId: "user-1",
  orgIds: [orgId],
  isInstanceAdmin: false,
};
const agentActor: Request["actor"] = {
  type: "agent",
  source: "agent_key",
  agentId: "agent-1",
  orgId,
  keyId: "key-1",
};

type LiveRunRead = (
  actor: Request["actor"],
  organizationId: string,
  options: { issueId: string | null; goalId: string | null; minCount: number },
) => Promise<RustFoundationResponse>;

const liveRunRead = vi.fn<LiveRunRead>();
const select = vi.fn(() => {
  throw new Error("Node live-run SQL must not execute");
});
const activeServers = new Set<Server>();

async function createApp(options: {
  actor?: Request["actor"];
  bridge?: { liveRunRead?: LiveRunRead } | null;
} = {}) {
  const actor = options.actor ?? boardActor;
  const app = express();
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  const router = express.Router();
  registerAgentManagementRoutes({
    router,
    db: { select } as unknown as Db,
    heartbeat: {},
    access: {},
    rustFoundationBridge: options.bridge === undefined ? { liveRunRead } : options.bridge,
  });
  app.use("/api", router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("Rust-backed live-run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({ id: issueId, orgId });
    mockIssueService.getByIdentifier.mockResolvedValue({ id: issueId, orgId });
    liveRunRead.mockResolvedValue({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: Buffer.from("[]"),
    });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    activeServers.clear();
    expect(select).not.toHaveBeenCalled();
  });

  describe("organization live runs", () => {
    it.each([
      ["board", boardActor],
      ["agent", agentActor],
    ] as const)("forwards the authorized %s actor and default filters", async (_name, actor) => {
      const res = await request(await createApp({ actor })).get(`/api/orgs/${orgId}/live-runs`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(actor, orgId, {
        issueId: null,
        goalId: null,
        minCount: 0,
      });
      expect(mockIssueService.getById).not.toHaveBeenCalled();
      expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    });

    it.each([
      ["a session board", boardActor, 403, "User does not have access to this organization"],
      ["an agent", agentActor, 403, "Agent key cannot access another organization"],
      ["an unauthenticated caller", { type: "none", source: "none" }, 401, "Unauthorized"],
    ] as const)("rejects %s outside its organization before calling Rust", async (_name, actor, status, error) => {
      const res = await request(await createApp({ actor }))
        .get(`/api/orgs/${otherOrgId}/live-runs`);

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error });
      expect(liveRunRead).not.toHaveBeenCalled();
    });

    it.each([
      ["local board", { ...boardActor, source: "local_implicit" }],
      ["instance administrator", { ...boardActor, isInstanceAdmin: true }],
    ] as const)("retains %s access outside its orgIds list", async (_name, actor) => {
      const res = await request(await createApp({ actor }))
        .get(`/api/orgs/${otherOrgId}/live-runs`);

      expect(res.status).toBe(200);
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(actor, otherOrgId, {
        issueId: null,
        goalId: null,
        minCount: 0,
      });
    });

    it.each([
      ["", 0],
      ["?minCount=", 0],
      ["?minCount=7", 7],
      ["?minCount=0", 0],
      ["?minCount=-5", 0],
      ["?minCount=20", 20],
      ["?minCount=999", 20],
      ["?minCount=3.9", 3],
      ["?minCount=8runs", 8],
      ["?minCount=1e2", 1],
      ["?minCount=0x10", 0],
      ["?minCount=not-a-number", 0],
      ["?minCount=Infinity", 0],
      ["?minCount=%20%2B6%20", 6],
      ["?minCount=7&minCount=19", 7],
      ["?minCount=bad&minCount=19", 0],
      ["?minCount=&minCount=19", 0],
    ])("preserves legacy minCount parsing for %s", async (query, minCount) => {
      const res = await request(await createApp()).get(`/api/orgs/${orgId}/live-runs${query}`);

      expect(res.status).toBe(200);
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(boardActor, orgId, {
        issueId: null,
        goalId: null,
        minCount,
      });
    });

    it.each([
      [`?goalId=${goalId}&minCount=4`, goalId, 4],
      [`?goalId=${goalId.toLowerCase()}`, goalId.toLowerCase(), 0],
      // The old route validates hex/hyphen length, not canonical UUID grouping.
      [`?goalId=${"a".repeat(36)}`, "a".repeat(36), 0],
      ["?goalId=", null, 0],
      ["?goalId=not-a-uuid", null, 0],
      [`?goalId=${"g".repeat(36)}`, null, 0],
      [`?goalId=%20${goalId}`, null, 0],
      [`?goalId=${goalId}&goalId=${issueId}`, null, 0],
      [`?goalId=${goalId}&goalId=${goalId}`, null, 0],
    ])("preserves legacy goalId validation for %s", async (query, parsedGoalId, minCount) => {
      const res = await request(await createApp()).get(`/api/orgs/${orgId}/live-runs${query}`);

      expect(res.status).toBe(200);
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(boardActor, orgId, {
        issueId: null,
        goalId: parsedGoalId,
        minCount,
      });
    });
  });

  describe("issue live runs", () => {
    it.each(["RUD-475", "rud-475", "RuD-475"])("resolves identifier %s without changing its case", async (reference) => {
      const res = await request(await createApp()).get(`/api/issues/${reference}/live-runs`);

      expect(res.status).toBe(200);
      expect(mockIssueService.getByIdentifier).toHaveBeenCalledExactlyOnceWith(reference);
      expect(mockIssueService.getById).not.toHaveBeenCalled();
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(boardActor, orgId, {
        issueId,
        goalId: null,
        minCount: 0,
      });
    });

    it("uses the UUID lookup and resolved issue identity, ignoring org-only query filters", async () => {
      const res = await request(await createApp({ actor: agentActor }))
        .get(`/api/issues/${issueId}/live-runs?goalId=${goalId}&minCount=20`);

      expect(res.status).toBe(200);
      expect(mockIssueService.getById).toHaveBeenCalledExactlyOnceWith(issueId);
      expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
      expect(liveRunRead).toHaveBeenCalledExactlyOnceWith(agentActor, orgId, {
        issueId,
        goalId: null,
        minCount: 0,
      });
    });

    it.each([issueId, "rud-999"])("keeps a missing issue %s as 404 without calling Rust", async (reference) => {
      mockIssueService.getById.mockResolvedValue(null);
      mockIssueService.getByIdentifier.mockResolvedValue(null);

      const res = await request(await createApp({ bridge: null })).get(`/api/issues/${reference}/live-runs`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Issue not found" });
      expect(liveRunRead).not.toHaveBeenCalled();
    });

    it.each([
      ["board", boardActor, issueId, "User does not have access to this organization"],
      ["agent", agentActor, "rud-475", "Agent key cannot access another organization"],
    ] as const)("rejects a %s reading a resolved cross-org issue", async (_name, actor, reference, error) => {
      mockIssueService.getById.mockResolvedValue({ id: issueId, orgId: otherOrgId });
      mockIssueService.getByIdentifier.mockResolvedValue({ id: issueId, orgId: otherOrgId });

      const res = await request(await createApp({ actor })).get(`/api/issues/${reference}/live-runs`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error });
      expect(liveRunRead).not.toHaveBeenCalled();
    });
  });

  describe.each([
    ["organization", `/api/orgs/${orgId}/live-runs`],
    ["issue", `/api/issues/${issueId}/live-runs`],
  ])("%s response forwarding and fail-closed behavior", (_name, url) => {
    it("forwards Rust JSON bytes without parsing, projecting, or reserializing them", async () => {
      // Whitespace, integer precision, and extra fields detect JSON round trips.
      const body = '[\n {"id":"run-1", "futureField":9007199254740993,"agentName":"测试","resultJson":{"ok":true}}\n]\n';
      liveRunRead.mockResolvedValue({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: Buffer.from(body),
      });

      const res = await request(await createApp()).get(url);

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(res.text).toBe(body);
      expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(body));
      expect(liveRunRead).toHaveBeenCalledTimes(1);
    });

    it("forwards Rust error status, content type, and response bytes", async () => {
      const body = '{ "error": "Rust rejected the read", "code": "invalid_filter" }\n';
      liveRunRead.mockResolvedValue({
        status: 422,
        contentType: "application/problem+json; charset=utf-8",
        body: Buffer.from(body),
      });

      const res = await request(await createApp()).get(url);

      expect(res.status).toBe(422);
      expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
      expect(res.text).toBe(body);
      expect(liveRunRead).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["absent bridge", null],
      ["bridge without liveRunRead", {}],
    ] as const)("fails closed with 503 for an %s", async (_label, bridge) => {
      const res = await request(await createApp({ bridge })).get(url);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Rust live-run reads are unavailable" });
      expect(liveRunRead).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when the Rust bridge rejects", async () => {
      liveRunRead.mockRejectedValue(new Error("Rust worker disconnected"));

      const res = await request(await createApp()).get(url);

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "Rust live-run reads are unavailable" });
      expect(liveRunRead).toHaveBeenCalledTimes(1);
    });
  });
});
