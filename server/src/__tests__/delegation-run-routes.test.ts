import { agentWakeupRequests, agents } from "@rudderhq/db";
import express, { Router } from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { registerAgentManagementRoutes } from "../routes/agents.management-routes.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const sourceAgentId = "22222222-2222-4222-8222-222222222222";
const sourceRunId = "33333333-3333-4333-8333-333333333333";
const targetRunId = "44444444-4444-4444-8444-444444444444";
const wakeupRequestId = "55555555-5555-4555-8555-555555555555";

const mockLogActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({
  issueService: vi.fn(),
  logActivity: mockLogActivity,
  syncInstructionsBundleConfigFromFilePath: vi.fn(),
}));

function createDbStub(task: string) {
  let wakeupRequestLookups = 0;
  const select = vi.fn(() => {
    let table: unknown;
    const builder: any = {
      from(value: unknown) {
        table = value;
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        const rows = table === agents
          ? [{ id: sourceAgentId, orgId }]
          : table === agentWakeupRequests
            ? (++wakeupRequestLookups === 1
              ? []
              : [{
                  id: wakeupRequestId,
                  orgId,
                  agentId: sourceAgentId,
                  status: "queued",
                  runId: targetRunId,
                  payload: {
                    delegationTask: task,
                    delegationTargetAgentId: sourceAgentId,
                  },
                }])
            : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  });
  return { select } as any;
}

function createRun(overrides: Record<string, unknown> = {}) {
  return {
    id: targetRunId,
    orgId,
    agentId: sourceAgentId,
    invocationSource: "delegation",
    triggerDetail: "agent_run_created",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    error: null,
    wakeupRequestId,
    sourceRunId,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    sessionReuseScope: "none",
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    chatConversationId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: {
      scene: "delegation",
      targetType: "wakeup_request",
      sourceRunId,
      delegationTask: "Inspect the target independently",
    },
    createdAt: new Date("2026-08-20T17:00:00.000Z"),
    updatedAt: new Date("2026-08-20T17:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Delegation Run route", () => {
  it("derives source identity from the authenticated Run and returns the admission contract", async () => {
    const task = "Inspect the target independently";
    const heartbeat = {
      getRun: vi.fn()
        .mockResolvedValueOnce({ id: sourceRunId, orgId, agentId: sourceAgentId, status: "running" })
        .mockResolvedValueOnce(createRun()),
      wakeup: vi.fn().mockResolvedValue(createRun()),
    };
    const db = createDbStub(task);
    const router = Router();
    registerAgentManagementRoutes({
      router,
      db,
      svc: {
        getById: vi.fn().mockResolvedValue({
          id: sourceAgentId,
          orgId,
          name: "Source Agent",
        }),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
      heartbeat,
    } as any);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: sourceAgentId,
        orgId,
        runId: sourceRunId,
      };
      next();
    });
    app.use("/api", router);
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/agent-runs/delegation")
      .send({
        task,
        idempotencyKey: "delegation-route-1",
        sourceRunId: randomUUID(),
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      runId: targetRunId,
      wakeupRequestId,
      sourceRunId,
      targetAgentId: sourceAgentId,
      scene: "delegation",
      admissionStatus: "queued",
      replayed: false,
      run: {
        id: targetRunId,
        scene: "delegation",
        sourceRunId,
      },
    });
    expect(heartbeat.wakeup).toHaveBeenCalledWith(sourceAgentId, expect.objectContaining({
      sourceRunId,
      contextSnapshot: expect.objectContaining({ sourceRunId }),
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent_run.delegated",
      details: expect.not.objectContaining({ delegationTask: task }),
    }));
  });
});
