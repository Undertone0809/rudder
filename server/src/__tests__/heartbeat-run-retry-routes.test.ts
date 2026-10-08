import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";

const mockHeartbeatService = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  getRun: vi.fn(),
  list: vi.fn(),
  overview: vi.fn(),
  retryRun: vi.fn(),
}));

const mockRunRead = vi.hoisted(() => vi.fn());

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
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
  issueService: () => mockIssueService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
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

const activeServers = new Set<Server>();
const sourceRunId = "409695f1-f90a-4b17-be61-4f0c6fe37c41";
const missingRunId = "409695f1-f90a-4b17-be61-4f0c6fe37c49";

async function startApp(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    orgIds: ["organization-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
  identityRows: Array<{ id: string }> = [{ id: sourceRunId }],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createRunIdLookupDb(identityRows) as any, undefined, { runRead: mockRunRead } as any));
  app.use(errorHandler);
  return startApp(app);
}

async function createManagementApp(db: Record<string, unknown>, actor: Record<string, unknown>) {
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
    svc: mockAgentService,
    heartbeat: mockHeartbeatService,
    workspaceOperations: {},
    rustFoundationBridge: { runRead: mockRunRead },
    getCurrentUserRedactionOptions: vi.fn(async () => ({ censorUsernameInLogs: false })),
  } as any);
  app.use("/api", router);
  app.use(errorHandler);
  return startApp(app);
}

function createRunIdLookupDb(rows: Array<{ id: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows),
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => rows),
          })),
        })),
      })),
    })),
  };
}

describe("agent run retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("forwards normalized date filters to Rust without applying the default limit", async () => {
    const res = await request(await createApp()).get("/api/orgs/organization-1/heartbeat-runs")
      .query({ startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-16T12:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(mockRunRead).toHaveBeenCalledWith(expect.anything(), "organization-1", {
      operation: "list", surface: "heartbeat", agentId: null, goalId: null,
      startDate: "2026-06-10T00:00:00.000Z", endDate: "2026-06-16T12:00:00.000Z", limit: null,
    });
    expect(mockHeartbeatService.list).not.toHaveBeenCalled();
  });

  it("dispatches the org overview to Rust with its public response unchanged", async () => {
    const body = { latestByAgent: [], recent: [] };
    mockRunRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
    const res = await request(await createApp()).get("/api/orgs/organization-1/agent-runs/overview");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(mockRunRead).toHaveBeenCalledWith(expect.anything(), "organization-1", { operation: "overview" });
    expect(mockHeartbeatService.overview).not.toHaveBeenCalled();
  });

  it("keeps full-row GET projection authority native after identity-only access checks", async () => {
    const runId = "609695f1-f90a-4b17-be61-4f0c6fe37c42";
    const body = { id: runId, contextSnapshot: { public: true } };
    mockRunRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) });
    mockIssueService.getByIdentifier.mockResolvedValue({ id: "issue-1", orgId: "organization-1" });
    const app = await createManagementApp(createRunIdLookupDb([{ id: runId, orgId: "organization-1" } as any]), {
      type: "board", userId: "board-user", orgIds: ["organization-1"], source: "session", isInstanceAdmin: false,
    });
    for (const path of [`/api/heartbeat-runs/${runId}`, `/api/agent-runs/${runId}`, "/api/issues/ZST-776/active-run"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(body);
    }
    expect(mockRunRead.mock.calls.map((call) => call[2].operation)).toEqual(["detail", "detail", "active"]);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.getActiveRunForAgent).not.toHaveBeenCalled();
  });

  it("forwards the agent-runs alias and explicit pagination to native authority", async () => {
    const res = await request(await createApp()).get("/api/orgs/organization-1/agent-runs").query({ agentId: "agent-1", limit: "25" });
    expect(res.status).toBe(200);
    expect(mockRunRead).toHaveBeenCalledWith(expect.anything(), "organization-1", {
      operation: "list", surface: "agent", agentId: "agent-1", goalId: null, startDate: null, endDate: null, limit: 25,
    });
    expect(mockHeartbeatService.list).not.toHaveBeenCalled();
  });

  it("retries a failed run through the dedicated recovery endpoint", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: sourceRunId,
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "queued",
      contextSnapshot: {
        recovery: {
          originalRunId: sourceRunId,
          failureKind: "process_lost",
          failureSummary: "child pid disappeared",
          recoveryTrigger: "manual",
          recoveryMode: "continue_preferred",
        },
      },
    });

    const res = await request(await createApp()).post(`/api/heartbeat-runs/${sourceRunId}/retry`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith(sourceRunId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        action: "heartbeat.retried",
        entityId: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
        details: expect.objectContaining({
          originalRunId: sourceRunId,
          recoveryTrigger: "manual",
        }),
      }),
    );
  });

  it("retries through the agent-runs alias and returns normalized metadata", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: sourceRunId,
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
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

    const res = await request(await createApp()).post(`/api/agent-runs/${sourceRunId}/retry`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith(sourceRunId, {
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });
    expect(res.body).toEqual(expect.objectContaining({
      id: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
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
      id: sourceRunId,
      orgId: "organization-1",
      agentId: "agent-1",
      status: "failed",
    });
    mockHeartbeatService.retryRun.mockResolvedValue({
      id: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
      orgId: "organization-1",
      agentId: "agent-1",
      status: "queued",
      contextSnapshot: {
        recovery: {
          originalRunId: sourceRunId,
          recoveryTrigger: "manual",
        },
      },
    });

    const res = await request(
      await createApp({
        type: "agent",
        orgId: "organization-1",
        agentId: "agent-1",
        runId: "caller-run",
      }),
    ).post(`/api/heartbeat-runs/${sourceRunId}/retry`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.retryRun).toHaveBeenCalledWith(sourceRunId, {
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
        entityId: "409695f1-f90a-4b17-be61-4f0c6fe37c42",
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

    const res = await request(await createManagementApp(createRunIdLookupDb([
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
      id: sourceRunId,
      orgId: "organization-1",
      agentId: "agent-1",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: sourceRunId,
      orgId: "organization-1",
      agentId: "agent-1",
      status: "cancelled",
    });

    const res = await request(
      await createApp({
        type: "agent",
        orgId: "organization-1",
        agentId: "agent-1",
        runId: "caller-run",
      }),
    ).post(`/api/heartbeat-runs/${sourceRunId}/cancel`).send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(sourceRunId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "heartbeat.cancelled",
        entityId: sourceRunId,
      }),
    );
  });

  it("returns 404 when the source run does not exist", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(await createApp(undefined, [])).post(`/api/heartbeat-runs/${missingRunId}/retry`).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(mockHeartbeatService.retryRun).not.toHaveBeenCalled();
  });

  it("returns agent-run 404 copy through the agent-runs alias", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(await createApp(undefined, [])).post(`/api/agent-runs/${missingRunId}/retry`).send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent run not found" });
    expect(mockHeartbeatService.retryRun).not.toHaveBeenCalled();
  });
  it.each(["retry", "cancel"])("does not %s a Run rejected by identity admission", async (operation) => {
    // The legacy service has a Run, but the identity-only query hides it. A
    // transport unit test must not bypass the actual reference-admission step.
    mockHeartbeatService.getRun.mockResolvedValue({ id: sourceRunId, orgId: "organization-1", agentId: "agent-1", status: "failed" });
    const response = await request(await createApp(undefined, []))
      .post(`/api/agent-runs/${sourceRunId}/${operation}`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.retryRun).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

});
