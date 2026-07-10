import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";

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

function createApp(db: Record<string, unknown> = {}) {
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
  app.use("/api", activityRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes activity list principal filters to the service", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        userId: "user-1",
        actorType: "user",
        actorId: "user-1",
        entityType: "project",
      });

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      orgId: "organization-1",
      agentId: undefined,
      userId: "user-1",
      actorType: "user",
      actorId: "user-1",
      entityType: "project",
      entityId: undefined,
    });
  });

  it("passes paginated activity list parameters to the service", async () => {
    mockActivityService.listPage.mockResolvedValue({
      items: [{ id: "activity-1" }],
      nextCursor: "next-page",
    });

    const res = await request(createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        actorType: "system",
        limit: "25",
        cursor: "cursor-1",
      });

    expect(res.status).toBe(200);
    expect(mockActivityService.listPage).toHaveBeenCalledWith({
      orgId: "organization-1",
      agentId: undefined,
      userId: undefined,
      actorType: "system",
      actorId: undefined,
      entityType: undefined,
      entityId: undefined,
      limit: 25,
      cursor: "cursor-1",
    });
    expect(mockActivityService.list).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      items: [{ id: "activity-1" }],
      nextCursor: "next-page",
    });
  });

  it("rejects cross-organization activity creation", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-2/activity")
      .send({
        actorType: "user",
        actorId: "user-1",
        action: "project.updated",
        entityType: "project",
        entityId: "project-2",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("rejects activity actor injection from non-admin organization members", async () => {
    const res = await request(createApp())
      .post("/api/orgs/organization-1/activity")
      .send({
        actorType: "system",
        actorId: "forged-system",
        action: "agent.approved",
        entityType: "agent",
        entityId: "agent-1",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("passes user activity ledger filters to the service", async () => {
    mockActivityService.listUserActivityLedger.mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const res = await request(createApp())
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
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("organization-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1" }]);
  });

  it("aliases agent run issue lookup to the agent run issue route", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
      },
    ]);

    const res = await request(createApp(createRunLookupDb({ orgId: "organization-1" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(200);
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual([{ issueId: "issue-1" }]);
  });

  it("does not expose run issues across organization boundaries", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
      },
    ]);

    const res = await request(createApp(createRunLookupDb({ orgId: "organization-2" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("keeps legacy heartbeat run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(createApp(createRunLookupDb(null)))
      .get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("uses agent-run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(createApp(createRunLookupDb(null)))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
