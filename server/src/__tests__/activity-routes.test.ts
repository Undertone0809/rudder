import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  listPage: vi.fn(),
  listUserActivityLedger: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
}));

const mockActivityRead = vi.hoisted(() => vi.fn());
const mockRunReference = vi.hoisted(() => vi.fn());
vi.mock("../services/heartbeat-run-reference.js", () => ({ resolveHeartbeatRunIdReference: mockRunReference }));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

function createRunLookupDb(run: { orgId: string } | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => run ? [run] : []),
      })),
    })),
  };
}

const activeServers = new Set<Server>();

const boardActor = {
  type: "board", userId: "user-1", orgIds: ["organization-1"], source: "session", isInstanceAdmin: false,
} as const;
const bridge = { activityRead: mockActivityRead, mode: "off", projectGoalSetMode: "off" } as unknown as RustFoundationBridge;

async function createApp(db: Record<string, unknown> = {}, selectedBridge: RustFoundationBridge | undefined = bridge, actor: unknown = boardActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes(db as any, selectedBridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockRunReference.mockImplementation(async (_db, ref) => ref);
    mockActivityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("forwards every activity principal filter to Rust with mutation modes off", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        userId: "user-1",
        actorType: "user",
        actorId: "user-1",
        entityType: "project",
      });

    expect(res.status).toBe(200);
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", {
      operation: "organization",
      filters: {
        agentId: undefined,
        userId: "user-1",
        actorType: "user",
        actorId: "user-1",
        entityType: "project",
        entityId: undefined,
      },
    });
    expect(mockActivityService.list).not.toHaveBeenCalled();
    expect(mockActivityService.listPage).not.toHaveBeenCalled();
  });

  it("forwards pagination and returns the native cursor unchanged", async () => {
    mockActivityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({
      items: [{ id: "activity-1" }], nextCursor: "next-page",
    })) });

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        actorType: "system",
        limit: "25",
        cursor: "cursor-1",
      });

    expect(res.status).toBe(200);
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", {
      operation: "organization",
      filters: {
        agentId: undefined,
        userId: undefined,
        actorType: "system",
        actorId: undefined,
        entityType: undefined,
        entityId: undefined,
      },
      page: { limit: 25, cursor: "cursor-1" },
    });
    expect(mockActivityService.list).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      items: [{ id: "activity-1" }],
      nextCursor: "next-page",
    });
  });

  it("passes user activity ledger filters to the service", async () => {
    mockActivityService.listUserActivityLedger.mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/users/me/activity-ledger")
      .query({
        since: "2026-06-18T00:00:00.000Z",
        until: "2026-06-19T00:00:00.000Z",
        include: "chat,comments,approvals",
        agentId: "agent-1",
        projectId: "project-1",
        issueId: "issue-1",
        limit: "10",
        cursor: "cursor-1",
      });

    expect(res.status).toBe(200);
    expect(mockActivityService.listUserActivityLedger).toHaveBeenCalledWith({
      orgId: "organization-1",
      userId: "user-1",
      since: new Date("2026-06-18T00:00:00.000Z"),
      until: new Date("2026-06-19T00:00:00.000Z"),
      include: ["chat", "comments", "approvals"],
      agentId: "agent-1",
      projectId: "project-1",
      issueId: "issue-1",
      limit: 10,
      cursor: "cursor-1",
    });
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      orgId: "organization-1",
    });
    const nativeBody = Buffer.from('[{"runId":"run-1","contextSnapshot":{"issueId":"issue-uuid-1","resumeFromRunId":"source-run-id"}}]');
    mockActivityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: nativeBody });

    const res = await request(await createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", { operation: "issue_runs", issueId: "issue-uuid-1" });
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
    expect(res.text).toBe(nativeBody.toString());
    expect(res.body).toEqual([{
      runId: "run-1",
      contextSnapshot: {
        issueId: "issue-uuid-1",
        resumeFromRunId: "source-run-id",
      },
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /private-display-id|nested-private-session|nested\/private\/cwd|private-workspace|private\.example|private-ref/,
    );
  });

  it("aliases agent run issue lookup to the agent run issue route", async () => {
    mockActivityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from('[ { "issueId": "issue-1" } ]') });

    const res = await request(await createApp(createRunLookupDb({ orgId: "organization-1" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(200);
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", { operation: "run_issues", runId: "run-1" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
    expect(res.body).toEqual([{ issueId: "issue-1" }]);
  });

  it("does not expose run issues across organization boundaries", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
      },
    ]);

    const res = await request(await createApp(createRunLookupDb({ orgId: "organization-2" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
    expect(mockActivityRead).not.toHaveBeenCalled();
  });

  it("keeps legacy heartbeat run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(await createApp(createRunLookupDb(null)))
      .get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
    expect(mockActivityRead).not.toHaveBeenCalled();
  });

  it("uses agent-run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(await createApp(createRunLookupDb(null)))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
    expect(mockActivityRead).not.toHaveBeenCalled();
  });
  it("resolves run aliases inside the authorized scope before Rust dispatch", async () => {
    mockRunReference.mockResolvedValue("canonical-run-id");
    const db = createRunLookupDb({ orgId: "organization-1" });
    const res = await request(await createApp(db)).get("/api/agent-runs/run_abcd1234/issues");
    expect(res.status).toBe(200);
    expect(mockRunReference).toHaveBeenCalledWith(db, "run_abcd1234", { orgIds: ["organization-1"], notFoundMessage: "Agent run not found" });
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", { operation: "run_issues", runId: "canonical-run-id" });
  });

  it("returns an issue timeline entirely from Rust after resolving the issue", async () => {
    mockIssueService.getById.mockResolvedValue({ id: "old-issue", orgId: "organization-1" });
    const res = await request(await createApp()).get("/api/issues/old-issue/activity");
    expect(res.status).toBe(200);
    expect(mockActivityRead).toHaveBeenCalledWith(boardActor, "organization-1", { operation: "issue_activity", issueId: "old-issue" });
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
  });

  it.each([
    "/api/orgs/organization-1/activity",
    "/api/issues/old-issue/activity",
    "/api/issues/old-issue/runs",
    "/api/heartbeat-runs/run-1/issues",
    "/api/agent-runs/run-1/issues",
  ])("fails closed without a native response for %s", async (url) => {
    mockIssueService.getById.mockResolvedValue({ id: "old-issue", orgId: "organization-1" });
    mockActivityRead.mockRejectedValue(new Error("native stopped"));
    const res = await request(await createApp(createRunLookupDb({ orgId: "organization-1" }))).get(url);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rust_foundation_activity_read_request_failed");
    for (const method of ["list", "listPage", "forIssue", "runsForIssue", "issuesForRun"] as const) {
      expect(mockActivityService[method]).not.toHaveBeenCalled();
    }
  });

  it("fails closed when an older embedded bridge lacks the read method", async () => {
    const res = await request(await createApp({}, {} as RustFoundationBridge)).get("/api/orgs/organization-1/activity");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("rust_foundation_activity_read_unavailable");
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  it("rejects unauthorized principals before native selection", async () => {
    for (const actor of [{ type: "none" }, { type: "agent", agentId: "foreign", orgId: "other-org" }]) {
      const res = await request(await createApp({}, bridge, actor)).get("/api/orgs/organization-1/activity");
      expect(res.status).toBe(actor.type === "none" ? 401 : 403);
    }
    expect(mockActivityRead).not.toHaveBeenCalled();
  });

  it.each([400, 422, 500, 503])("passes native HTTP %s errors through without fallback", async (status) => {
    const body = '{ "error": "native failure", "code": "activity_read_failed" }';
    mockActivityRead.mockResolvedValue({ status, contentType: "application/json", body: Buffer.from(body) });
    const res = await request(await createApp()).get("/api/orgs/organization-1/activity");
    expect(res.status).toBe(status);
    expect(res.text).toBe(body);
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "invalid"])("rejects invalid public limit %s before dispatch", async (limit) => {
    const res = await request(await createApp()).get("/api/orgs/organization-1/activity").query({ limit });
    expect(res.status).toBe(400);
    expect(mockActivityRead).not.toHaveBeenCalled();
  });
});
