import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { errorHandler } from "../middleware/index.js";

const mockSidebarBadgeService = vi.hoisted(() => ({
  getBaseCounts: vi.fn(),
  countUnreadTouchedIssues: vi.fn(),
  countActiveChatAttention: vi.fn(),
  fromCounts: vi.fn((base, extra = {}) => {
    const joinRequests = extra.joinRequests ?? 0;
    const unreadTouchedIssues = extra.unreadTouchedIssues ?? 0;
    const chatAttention = extra.chatAttention ?? 0;
    const alerts = extra.alerts ?? 0;
    return {
      inbox: base.approvals + base.failedRuns + joinRequests + unreadTouchedIssues + chatAttention + alerts,
      approvals: base.approvals,
      failedRuns: base.failedRuns,
      joinRequests,
      unreadTouchedIssues,
      chatAttention,
      alerts,
    };
  }),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/sidebar-badges.js", () => ({
  sidebarBadgeService: () => mockSidebarBadgeService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

function createDb(joinRequestCount: number) {
  const countQuery = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn((onFulfilled: (rows: Array<{ count: number }>) => unknown) =>
      Promise.resolve(onFulfilled([{ count: joinRequestCount }])),
    ),
  };
  return {
    select: vi.fn().mockReturnValue(countQuery),
    countQuery,
  };
}

function createApp(actor: Record<string, unknown>, db: ReturnType<typeof createDb>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", sidebarBadgeRoutes(db as any));
  app.use(errorHandler);
  return app;
}

describe("GET /api/orgs/:orgId/sidebar-badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSidebarBadgeService.getBaseCounts.mockResolvedValue({ approvals: 1, failedRuns: 2 });
    mockSidebarBadgeService.countUnreadTouchedIssues.mockResolvedValue(3);
    mockSidebarBadgeService.countActiveChatAttention.mockResolvedValue(4);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockDashboardService.summary.mockResolvedValue({
      agents: { error: 1 },
      costs: { monthBudgetCents: 100, monthUtilizationPercent: 90 },
    });
  });

  it("aggregates board-only attention, join approvals, and alerts without changing response shape", async () => {
    const db = createDb(5);
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, db);

    const res = await request(app).get("/api/orgs/org-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      inbox: 16,
      approvals: 1,
      failedRuns: 2,
      joinRequests: 5,
      unreadTouchedIssues: 3,
      chatAttention: 4,
      alerts: 1,
    });
    expect(mockSidebarBadgeService.countUnreadTouchedIssues).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockSidebarBadgeService.countActiveChatAttention).toHaveBeenCalledWith("org-1", "user-1");
    expect(mockSidebarBadgeService.fromCounts).toHaveBeenCalledWith(
      { approvals: 1, failedRuns: 2 },
      { joinRequests: 5, unreadTouchedIssues: 3, chatAttention: 4, alerts: 1 },
    );
  });

  it("does not expose join-request counts to board actors without approval permission", async () => {
    const db = createDb(5);
    const app = createApp({
      type: "board",
      userId: "user-2",
      source: "session",
      orgIds: ["org-1"],
      isInstanceAdmin: false,
    }, db);

    const res = await request(app).get("/api/orgs/org-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body.joinRequests).toBe(0);
    expect(res.body.unreadTouchedIssues).toBe(3);
    expect(res.body.chatAttention).toBe(4);
    expect(mockAccessService.canUser).toHaveBeenCalledWith("org-1", "user-2", "joins:approve");
    expect(db.select).not.toHaveBeenCalled();
  });

  it("keeps agent actors on aggregate badges without board user attention", async () => {
    const db = createDb(5);
    const app = createApp({
      type: "agent",
      orgId: "org-1",
      agentId: "agent-1",
    }, db);

    const res = await request(app).get("/api/orgs/org-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      approvals: 1,
      failedRuns: 2,
      joinRequests: 0,
      unreadTouchedIssues: 0,
      chatAttention: 0,
      alerts: 1,
    });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith("org-1", "agent", "agent-1", "joins:approve");
    expect(mockSidebarBadgeService.countUnreadTouchedIssues).not.toHaveBeenCalled();
    expect(mockSidebarBadgeService.countActiveChatAttention).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
