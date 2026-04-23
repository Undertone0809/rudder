import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      orgIds: ["organization-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
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

  it("returns 404 when the source run does not exist", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(createApp()).post("/api/heartbeat-runs/missing/retry").send({});

    expect(res.status).toBe(404);
    expect(mockHeartbeatService.retryRun).not.toHaveBeenCalled();
  });
});
