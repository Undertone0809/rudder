import { agentWakeupRequests, agents } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import {
  DELEGATION_RUN_SCENE,
  DELEGATION_RUN_SOURCE,
  DELEGATION_RUN_TRIGGER_REASON,
  delegationRunService,
} from "./delegation-runs.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const sourceAgentId = "22222222-2222-4222-8222-222222222222";
const targetAgentId = "33333333-3333-4333-8333-333333333333";
const sourceRunId = "44444444-4444-4444-8444-444444444444";
const targetRunId = "55555555-5555-4555-8555-555555555555";
const wakeupRequestId = "66666666-6666-4666-8666-666666666666";

function sourceRun() {
  return {
    id: sourceRunId,
    orgId,
    agentId: sourceAgentId,
    status: "running",
  };
}

function targetRun(agentId = targetAgentId) {
  return {
    ...sourceRun(),
    id: targetRunId,
    agentId,
    invocationSource: "delegation",
    triggerDetail: "agent_run_created",
    sourceRunId,
    wakeupRequestId,
    contextSnapshot: {
      scene: DELEGATION_RUN_SCENE,
      sourceRunId,
      delegationTask: "Inspect the target independently",
    },
  };
}

function wakeupRequest(task: string, status = "queued", agentId = targetAgentId) {
  return {
    id: wakeupRequestId,
    orgId,
    agentId,
    source: DELEGATION_RUN_SOURCE,
    triggerDetail: "agent_run_created",
    reason: DELEGATION_RUN_TRIGGER_REASON,
    payload: {
      delegationTask: task,
      delegationTargetAgentId: targetAgentId,
      sourceRunId,
    },
    status,
    coalescedCount: 0,
    requestedByActorType: "agent",
    requestedByActorId: sourceAgentId,
    idempotencyKey: "delegation-key-1",
    runId: targetRunId,
  };
}

function createDbStub(input: {
  existingRequest?: Record<string, unknown> | null;
  persistedRequest?: Record<string, unknown> | null;
  targetAgentId?: string;
}) {
  let agentLookups = 0;
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
          ? (++agentLookups === 1
            ? [{ id: sourceAgentId, orgId }]
            : [{ id: input.targetAgentId ?? sourceAgentId, orgId }])
          : table === agentWakeupRequests
            ? (++wakeupRequestLookups === 1
              ? (input.existingRequest ? [input.existingRequest] : [])
              : (input.persistedRequest ? [input.persistedRequest] : []))
            : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  });
  return { select } as any;
}

describe("delegationRunService", () => {
  it("defaults to the current Agent and routes an isolated task through heartbeat wakeup", async () => {
    const wakeup = vi.fn().mockResolvedValue(targetRun());
    const db = createDbStub({
      persistedRequest: wakeupRequest("Inspect the target independently", "queued", sourceAgentId),
    });
    const service = delegationRunService(db, {
      heartbeat: {
        getRun: vi.fn()
          .mockResolvedValueOnce(sourceRun())
          .mockResolvedValueOnce(targetRun(sourceAgentId)),
        wakeup,
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    const result = await service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      idempotencyKey: "delegation-key-1",
    });

    expect(wakeup).toHaveBeenCalledWith(sourceAgentId, expect.objectContaining({
      source: DELEGATION_RUN_SOURCE,
      triggerDetail: "agent_run_created",
      reason: DELEGATION_RUN_TRIGGER_REASON,
      sourceRunId,
      idempotencyKey: "delegation-key-1",
      contextSnapshot: expect.objectContaining({
        scene: DELEGATION_RUN_SCENE,
        targetType: "wakeup_request",
        sourceRunId,
        forceFreshSession: true,
        delegationTask: "Inspect the target independently",
      }),
      payload: expect.objectContaining({
        delegationTask: "Inspect the target independently",
        sourceRunId,
      }),
    }));
    expect(result).toMatchObject({
      runId: targetRunId,
      wakeupRequestId,
      sourceRunId,
      targetAgentId: sourceAgentId,
      scene: DELEGATION_RUN_SCENE,
      admissionStatus: "queued",
      replayed: false,
    });
  });

  it("replays the same admission without invoking heartbeat twice", async () => {
    const existing = wakeupRequest("Inspect the target independently");
    const wakeup = vi.fn();
    const db = createDbStub({ existingRequest: existing, targetAgentId });
    const service = delegationRunService(db, {
      heartbeat: {
        getRun: vi.fn()
          .mockResolvedValueOnce(sourceRun())
          .mockResolvedValueOnce(targetRun()),
        wakeup,
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    const result = await service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      targetAgentId,
      idempotencyKey: "delegation-key-1",
    });

    expect(wakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      runId: targetRunId,
      wakeupRequestId,
      admissionStatus: "replayed",
      replayed: true,
    });
  });

  it("enforces the UTF-8 byte limit before admission", async () => {
    const service = delegationRunService(createDbStub({}), {
      heartbeat: { getRun: vi.fn(), wakeup: vi.fn() },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "🙂".repeat(5_001),
      idempotencyKey: "delegation-oversize",
    })).rejects.toMatchObject({ message: "Delegation task must be no more than 20,000 UTF-8 bytes" });
  });

  it("requires tasks:assign only for cross-agent delegation", async () => {
    const wakeup = vi.fn();
    const db = createDbStub({
      targetAgentId,
      persistedRequest: wakeupRequest("cross-agent task"),
    });
    const service = delegationRunService(db, {
      heartbeat: { getRun: vi.fn().mockResolvedValue(sourceRun()), wakeup },
      access: { hasPermission: vi.fn().mockResolvedValue(false) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "cross-agent task",
      targetAgentId,
      idempotencyKey: "delegation-key-cross-agent",
    })).rejects.toMatchObject({ message: "Missing permission: tasks:assign" });
    expect(wakeup).not.toHaveBeenCalled();
  });
});
