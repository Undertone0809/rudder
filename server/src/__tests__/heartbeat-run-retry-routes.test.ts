import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  list: vi.fn(),
  retryRun: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => ({}),
  agentInstructionsService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  approvalService: () => ({}),
  organizationSkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(),
  }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  logActivity: mockLogActivity,
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAgentRuntimeModels: vi.fn(),
}));

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    orgIds: ["organization-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("heartbeat run retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists heartbeat runs by date range without applying the default recency limit", async () => {
    mockHeartbeatService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/heartbeat-runs")
      .query({
        startDate: "2026-06-10T00:00:00.000Z",
        endDate: "2026-06-16T12:00:00.000Z",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith(
      "organization-1",
      undefined,
      undefined,
      {
        startDate: new Date("2026-06-10T00:00:00.000Z"),
        endDate: new Date("2026-06-16T12:00:00.000Z"),
      },
    );
  });

  it("retries a failed run through the dedicated recovery endpoint", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "run-2",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "queued",
      contextSnapshot: {
        recovery: {
          originalRunId: "run-1",
          failureKind: "process_lost",
          failureSummary: "child pid disappeared",
          recoveryTrigger: "manual",
          recoveryMode: "continue_preferred",
        },
      },
    });

    const res = await request(createApp()).post("/api/heartbeat-runs/run-1/retry").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith("run-1", {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "heartbeat.retried",
        entityId: "run-2",
        details: expect.objectContaining({
          originalRunId: "run-1",
          recoveryTrigger: "manual",
        }),
      }),
    );
  });

  it("retries a failed run with agent attribution for same-organization agent callers", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "run-2",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "queued",
      contextSnapshot: {
        recovery: {
          originalRunId: "run-1",
          recoveryTrigger: "manual",
        },
      },
    });

    const res = await request(
      createApp({
        type: "agent",
        orgId: "organization-1",
        agentId: "agent-1",
        runId: "caller-run",
      }),
    ).post("/api/heartbeat-runs/run-1/retry").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith("run-1", {
      requestedByActorType: "agent",
      requestedByActorId: "agent-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "heartbeat.retried",
        entityId: "run-2",
      }),
    );
  });

  it("cancels a run with agent attribution for same-organization agent callers", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "cancelled",
    });

    const res = await request(
      createApp({
        type: "agent",
        orgId: "organization-1",
        agentId: "agent-1",
        runId: "caller-run",
      }),
    ).post("/api/heartbeat-runs/run-1/cancel").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "heartbeat.cancelled",
        entityId: "run-1",
      }),
    );
  });

  it("returns 404 when the source run does not exist", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(createApp()).post("/api/heartbeat-runs/missing/retry").send({});

    expect(res.status).toBe(404);
    expect(mockHeartbeatService.retryRun).not.toHaveBeenCalled();
  });
});
