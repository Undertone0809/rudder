import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";

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

function createManagementApp(db: Record<string, unknown>, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const router = express.Router();
  registerAgentManagementRoutes({
    router,
    db,
    heartbeat: mockHeartbeatService,
    workspaceOperations: {},
    getCurrentUserRedactionOptions: vi.fn(async () => ({ censorUsernameInLogs: false })),
  } as any);
  app.use("/api", router);
  app.use(errorHandler);
  return app;
}

function createRunIdLookupDb(rows: Array<{ id: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
  };
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

  it("lists normalized agent runs through the agent-runs alias", async () => {
    mockHeartbeatService.list.mockResolvedValue([
      {
        id: "run-1",
        orgId: "organization-1",
        agentId: "agent-1",
        invocationSource: "chat",
        triggerDetail: "chat_assistant_reply_stream",
        status: "succeeded",
        startedAt: null,
        finishedAt: null,
        error: null,
        wakeupRequestId: null,
        exitCode: null,
        signal: null,
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logBytes: null,
        logSha256: null,
        logCompressed: false,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        errorCode: null,
        externalRunId: null,
        chatConversationId: "conversation-1",
        processPid: null,
        processStartedAt: null,
        retryOfRunId: null,
        processLossRetryCount: 0,
        contextSnapshot: {
          assistantMessageId: "assistant-message-1",
        },
        createdAt: new Date("2026-06-20T00:00:00.000Z"),
        updatedAt: new Date("2026-06-20T00:00:00.000Z"),
      },
    ]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/agent-runs")
      .query({
        agentId: "agent-1",
        limit: "25",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith(
      "organization-1",
      "agent-1",
      25,
      {
        startDate: undefined,
        endDate: undefined,
      },
    );
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "run-1",
        scene: "chat",
        triggerKind: "chat_assistant_reply_stream",
        targetType: "chat_conversation",
        targetId: "conversation-1",
        conversationId: "conversation-1",
        messageId: "assistant-message-1",
        automationRunId: null,
        automationId: null,
        wakeupRequestId: null,
      }),
    ]);
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

  it("retries through the agent-runs alias and returns normalized metadata", async () => {
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
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: "wakeup-1",
      contextSnapshot: {
        targetType: "automation_run",
        targetId: "automation-run-1",
        automationRunId: "automation-run-1",
        automationId: "automation-1",
      },
    });

    const res = await request(createApp()).post("/api/agent-runs/run-1/retry").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith("run-1", {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(res.body).toEqual(expect.objectContaining({
      id: "run-2",
      scene: "automation",
      triggerKind: "system",
      targetType: "automation_run",
      targetId: "automation-run-1",
      automationRunId: "automation-run-1",
      automationId: "automation-1",
      wakeupRequestId: "wakeup-1",
    }));
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

  it("resolves short run IDs within the caller organization scope before retrying", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "609695f1-f90a-4b17-be61-4f0c6fe37c42",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "retry-run",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "queued",
      contextSnapshot: {},
    });

    const res = await request(createManagementApp(createRunIdLookupDb([
      { id: "609695f1-f90a-4b17-be61-4f0c6fe37c42" },
    ]), {
      type: "board",
      userId: "board-user",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    })).post("/api/heartbeat-runs/609695f1f90a/retry").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith("609695f1-f90a-4b17-be61-4f0c6fe37c42", {
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
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
