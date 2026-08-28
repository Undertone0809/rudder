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
const otherSourceAgentId = "77777777-7777-4777-8777-777777777777";
const otherSourceRunId = "88888888-8888-4888-8888-888888888888";
const otherTargetAgentId = "99999999-9999-4999-8999-999999999999";

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
      sourceAgentId,
      sourceRunId,
    },
    status,
    coalescedCount: 0,
    requestedByActorType: "agent",
    requestedByActorId: sourceAgentId,
    idempotencyKey: "delegation-key-1",
    delegationIdempotencyKey: "delegation-key-1",
    runId: targetRunId,
  };
}

function createDbStub(input: {
  existingRequest?: Record<string, unknown> | null;
  persistedRequest?: Record<string, unknown> | null;
  targetAgentId?: string;
  sourceAgent?: Record<string, unknown> | null;
  targetAgent?: Record<string, unknown> | null;
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
            ? (input.sourceAgent === null ? [] : [input.sourceAgent ?? { id: sourceAgentId, orgId }])
            : (input.targetAgent === null
              ? []
              : [input.targetAgent ?? { id: input.targetAgentId ?? sourceAgentId, orgId }]))
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
      delegationIdempotencyKey: "delegation-key-1",
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

  it("rejects a conflicting task that wins the organization-wide admission race", async () => {
    const racedRequest = wakeupRequest("different task");
    const db = createDbStub({ persistedRequest: racedRequest, targetAgentId });
    const service = delegationRunService(db, {
      heartbeat: {
        getRun: vi.fn().mockResolvedValue(sourceRun()),
        wakeup: vi.fn().mockResolvedValue(targetRun()),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      targetAgentId,
      idempotencyKey: "delegation-key-1",
    })).rejects.toMatchObject({
      message: "Delegation idempotency key conflicts with an existing task or target",
    });
  });

  it("rejects reusing an organization-wide idempotency key for another target", async () => {
    const existing = wakeupRequest("Inspect the target independently");
    const wakeup = vi.fn();
    const service = delegationRunService(createDbStub({
      existingRequest: existing,
      targetAgent: { id: otherTargetAgentId, orgId },
    }), {
      heartbeat: { getRun: vi.fn().mockResolvedValue(sourceRun()), wakeup },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      targetAgentId: otherTargetAgentId,
      idempotencyKey: "delegation-key-1",
    })).rejects.toMatchObject({
      message: "Delegation idempotency key conflicts with an existing task or target",
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("replays another source Run's matching organization, target, key, and task with persisted provenance", async () => {
    const existing = {
      ...wakeupRequest("Inspect the target independently"),
      requestedByActorId: otherSourceAgentId,
      payload: {
        ...wakeupRequest("Inspect the target independently").payload,
        sourceAgentId: otherSourceAgentId,
        sourceRunId: otherSourceRunId,
      },
    };
    const wakeup = vi.fn();
    const service = delegationRunService(createDbStub({ existingRequest: existing, targetAgentId }), {
      heartbeat: {
        getRun: vi.fn()
          .mockResolvedValueOnce(sourceRun())
          .mockResolvedValueOnce({ ...targetRun(), sourceRunId: otherSourceRunId }),
        wakeup,
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      targetAgentId,
      idempotencyKey: "delegation-key-1",
    })).resolves.toMatchObject({
      sourceAgentId: otherSourceAgentId,
      sourceRunId: otherSourceRunId,
      admissionStatus: "replayed",
      replayed: true,
    });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("rejects a source Run owned by another authenticated Agent", async () => {
    const service = delegationRunService(createDbStub({}), {
      heartbeat: {
        getRun: vi.fn().mockResolvedValue({ ...sourceRun(), agentId: otherSourceAgentId }),
        wakeup: vi.fn(),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      idempotencyKey: "source-owner-mismatch",
    })).rejects.toMatchObject({ message: "Source Run does not belong to the authenticated Agent" });
  });

  it("rejects missing and cross-organization targets", async () => {
    const missingTarget = delegationRunService(createDbStub({ targetAgent: null }), {
      heartbeat: { getRun: vi.fn().mockResolvedValue(sourceRun()), wakeup: vi.fn() },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });
    await expect(missingTarget.create({
      sourceAgentId,
      sourceRunId,
      targetAgentId,
      task: "Inspect the target independently",
      idempotencyKey: "missing-target",
    })).rejects.toMatchObject({ message: "Target Agent not found" });

    const crossOrgTarget = delegationRunService(createDbStub({
      targetAgent: { id: targetAgentId, orgId: "99999999-9999-4999-8999-999999999999" },
    }), {
      heartbeat: { getRun: vi.fn().mockResolvedValue(sourceRun()), wakeup: vi.fn() },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });
    await expect(crossOrgTarget.create({
      sourceAgentId,
      sourceRunId,
      targetAgentId,
      task: "Inspect the target independently",
      idempotencyKey: "cross-org-target",
    })).rejects.toMatchObject({ message: "Target Agent must belong to the same organization" });
  });

  it.each([
    ["deferred_agent_paused", "deferred"],
    ["coalesced", "coalesced"],
    ["skipped", "skipped"],
  ])("projects %s admission through the Delegation response as %s", async (status, expected) => {
    const persisted = {
      ...wakeupRequest("Inspect the target independently", status, sourceAgentId),
      runId: status === "skipped" ? null : targetRunId,
    };
    const service = delegationRunService(createDbStub({ persistedRequest: persisted }), {
      heartbeat: {
        getRun: vi.fn()
          .mockResolvedValueOnce(sourceRun())
          .mockResolvedValueOnce(targetRun(sourceAgentId)),
        wakeup: vi.fn().mockResolvedValue(status === "skipped" ? null : targetRun(sourceAgentId)),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      idempotencyKey: `admission-${status}`,
    })).resolves.toMatchObject({ admissionStatus: expected });
  });

  it("returns a traceable skipped admission when the target is unavailable", async () => {
    const skippedRequest = {
      ...wakeupRequest("Inspect the target independently", "skipped", sourceAgentId),
      runId: null,
    };
    const service = delegationRunService(createDbStub({ persistedRequest: skippedRequest }), {
      heartbeat: {
        getRun: vi.fn().mockResolvedValue(sourceRun()),
        wakeup: vi.fn().mockRejectedValue(new Error("Agent is not invokable in its current state")),
      },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "Inspect the target independently",
      idempotencyKey: "delegation-key-1",
    })).resolves.toMatchObject({
      runId: null,
      wakeupRequestId,
      admissionStatus: "skipped",
      replayed: false,
    });
  });

  it("enforces the Unicode character limit before admission", async () => {
    const service = delegationRunService(createDbStub({}), {
      heartbeat: { getRun: vi.fn(), wakeup: vi.fn() },
      access: { hasPermission: vi.fn().mockResolvedValue(true) },
    });

    await expect(service.create({
      sourceAgentId,
      sourceRunId,
      task: "🙂".repeat(20_001),
      idempotencyKey: "delegation-oversize",
    })).rejects.toMatchObject({ message: "Delegation task must be no more than 20,000 Unicode characters" });
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
