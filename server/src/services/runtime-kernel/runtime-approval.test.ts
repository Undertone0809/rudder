import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRuntimeApprovalBridge,
  validateRuntimeApprovalInputResponse,
} from "./runtime-approval.js";

const fence = {
  spanId: "span-1",
  ownerToken: "owner-1",
  attemptEpoch: 1,
  attemptId: "attempt-1",
  attemptIndex: 0,
};

function currentRows() {
  return [
    {
      id: "run-1",
      orgId: "org-1",
      agentId: "agent-1",
      status: "running",
      chatConversationId: "chat-1",
      executionOwnerToken: fence.ownerToken,
      executionLeaseExpiresAt: null,
    },
    {
      id: fence.attemptId,
      attemptIndex: fence.attemptIndex,
      status: "started",
      ownerToken: fence.ownerToken,
      attemptEpoch: fence.attemptEpoch,
    },
    {
      id: fence.spanId,
      ownerToken: fence.ownerToken,
      attemptEpoch: fence.attemptEpoch,
      attemptId: fence.attemptId,
      state: "open",
    },
  ];
}

function currentSelectRows() {
  return currentRows().map((row) => [row]);
}

function queryFor(value: unknown[]) {
  const query: Record<string, any> = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (resolve: (result: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
  return query;
}

function fakeDb(selectRows: unknown[][]) {
  const remainingRows = [...selectRows];
  const select = vi.fn(() => queryFor(remainingRows.shift() ?? []));
  const execute = vi.fn().mockResolvedValue([]);
  const insertReturning = vi.fn();
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ returning: insertReturning })),
  }));
  const updateReturning = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: updateWhere })),
  }));
  const tx = { select, execute, insert, update };
  const db = {
    select,
    execute,
    insert,
    update,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  return { db, tx, insertReturning, update, updateReturning };
}

function execution() {
  return {
    runId: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    runtimeType: "codex_local",
    chatConversationId: "chat-1",
    scene: "chat" as const,
    getFence: () => fence,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-1",
    runId: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    runtimeType: "codex_local",
    chatConversationId: "chat-1",
    scene: "chat",
    attemptId: fence.attemptId,
    attemptIndex: fence.attemptIndex,
    attemptEpoch: fence.attemptEpoch,
    spanId: fence.spanId,
    requestId: "request-1",
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    orgId: "org-1",
    type: "agent_runtime",
    requestedByAgentId: "agent-1",
    status: "pending",
    payload: payload(),
    ...overrides,
  } as any;
}

describe("runtime approval bridge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rechecks the execution inside an advisory-locked transaction before inserting", async () => {
    const fake = fakeDb([
      ...currentSelectRows(),
      ...currentSelectRows(),
      [],
    ]);
    fake.insertReturning.mockResolvedValueOnce([approval()]);
    const approvals = {
      create: vi.fn(),
      getById: vi.fn(),
    };
    const bridge = createRuntimeApprovalBridge({
      db: fake.db as any,
      approvals,
      execution: execution(),
      pollIntervalMs: 1,
    });

    const result = await bridge.requestApproval({
      type: "agent_runtime",
      payload: { requestId: "request-1", provider: "codex" },
    });

    expect(result.status).toBe("pending");
    expect(fake.db.transaction).toHaveBeenCalledTimes(1);
    expect(fake.tx.execute).toHaveBeenCalledTimes(1);
    expect(fake.insertReturning).toHaveBeenCalledTimes(1);
    expect(approvals.create).not.toHaveBeenCalled();
  });

  it("cancels an owned stale approval but never updates a cross-run approval", async () => {
    const owned = approval({ status: "pending" });
    const fake = fakeDb([]);
    fake.updateReturning.mockResolvedValueOnce([{ ...owned, status: "cancelled" }]);
    const approvals = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue(owned),
    };
    const controller = new AbortController();
    controller.abort();
    const bridge = createRuntimeApprovalBridge({
      db: fake.db as any,
      approvals,
      execution: { ...execution(), abortSignal: controller.signal },
      onEvent: vi.fn().mockResolvedValue(undefined),
    });

    const result = await bridge.waitForApproval("approval-1", 1_000);

    expect(result.status).toBe("cancelled");
    expect(fake.update).toHaveBeenCalledTimes(1);

    const crossRun = approval({ payload: payload({ runId: "other-run" }) });
    fake.update.mockClear();
    approvals.getById.mockResolvedValueOnce(crossRun);
    const crossRunBridge = createRuntimeApprovalBridge({
      db: fake.db as any,
      approvals,
      execution: { ...execution(), abortSignal: controller.signal },
    });
    await crossRunBridge.waitForApproval("approval-1", 1_000);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("does not accept an approved record whose attempt fence differs", async () => {
    const fake = fakeDb(currentSelectRows());
    const approvals = {
      create: vi.fn(),
      getById: vi.fn().mockResolvedValue(approval({
        status: "approved",
        payload: payload({ attemptEpoch: 2 }),
      })),
    };
    const bridge = createRuntimeApprovalBridge({
      db: fake.db as any,
      approvals,
      execution: execution(),
      pollIntervalMs: 1,
    });

    const result = await bridge.waitForApproval("approval-1", 1_000);

    expect(result.status).toBe("cancelled");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("validates structured answers against the exact input request", () => {
    const inputRequest = {
      questions: [{
        id: "question-1",
        question: "Continue?",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      }],
    };
    expect(validateRuntimeApprovalInputResponse(inputRequest, {
      answers: [{ questionId: "question-1", optionIds: ["yes"] }],
    })).toEqual({
      answers: [{ questionId: "question-1", optionIds: ["yes"] }],
    });
    expect(() => validateRuntimeApprovalInputResponse(inputRequest, {
      answers: [{ questionId: "question-1", optionIds: ["other"] }],
    })).toThrow("unknown option");
  });
});
