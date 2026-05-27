import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEvaluateCostEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockObserveExecutionEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({
    evaluateCostEvent: mockEvaluateCostEvent,
  }),
}));

vi.mock("../langfuse.js", () => ({
  observeExecutionEvent: mockObserveExecutionEvent,
}));

import { costService } from "../services/costs.js";

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

function currentMonthDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12, 0, 0, 0, 0));
}

function previousMonthDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12, 0, 0, 0, 0));
}

function costEventInsertChain(event: Record<string, unknown>) {
  return {
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([event]),
    }),
  };
}

function rollupInsertChain(rows: Array<Record<string, unknown>> = []) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

function rollupUpdateChain(spendCents: number) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ spendCents }]),
      }),
    }),
  };
}

describe("costService Langfuse export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes normalized token totals in cost summaries", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "org-1", budgetMonthlyCents: 10_000 }]))
        .mockReturnValueOnce(selectChain([
          {
            total: 123,
            inputTokens: 1_000,
            cachedInputTokens: 250,
            outputTokens: 500,
            totalTokens: 1_500,
            eventCount: 3,
            tokenEventCount: 2,
          },
        ])),
    };

    const svc = costService(db as never);
    await expect(svc.summary("org-1")).resolves.toMatchObject({
      spendCents: 123,
      inputTokens: 1_000,
      cachedInputTokens: 250,
      outputTokens: 500,
      totalTokens: 1_500,
      eventCount: 3,
      tokenEventCount: 2,
    });
  });

  it("normalizes cost summary aggregates above the Postgres int4 range", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "org-1", budgetMonthlyCents: 0 }]))
        .mockReturnValueOnce(selectChain([
          {
            total: 0,
            inputTokens: "2797218444",
            cachedInputTokens: "2648503296",
            outputTokens: "7422998",
            totalTokens: "2804641442",
            eventCount: 740,
            tokenEventCount: 740,
          },
        ])),
    };

    const svc = costService(db as never);
    await expect(svc.summary("org-1")).resolves.toMatchObject({
      inputTokens: 2_797_218_444,
      cachedInputTokens: 2_648_503_296,
      outputTokens: 7_422_998,
      totalTokens: 2_804_641_442,
      eventCount: 740,
      tokenEventCount: 740,
    });
  });

  it("emits a detached cost event when tied to a heartbeat run", async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(costEventInsertChain({
          id: "cost-1",
          orgId: "org-1",
          agentId: "agent-1",
          issueId: "issue-1",
          heartbeatRunId: "run-1",
          provider: "openai",
          model: "gpt-4.1",
          biller: "openai",
          billingType: "metered_api",
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          costCents: 34,
          occurredAt: currentMonthDate(),
        }))
        .mockReturnValueOnce(rollupInsertChain())
        .mockReturnValueOnce(rollupInsertChain()),
      update: vi
        .fn()
        .mockReturnValueOnce(rollupUpdateChain(12))
        .mockReturnValueOnce(rollupUpdateChain(34))
        .mockReturnValue({
          set: updateSet,
        }),
    };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "agent-1", orgId: "org-1" }])),
      transaction: vi.fn((callback) => callback(tx)),
    };

    const svc = costService(db as never);
    await svc.createEvent("org-1", {
      agentId: "agent-1",
      issueId: "issue-1",
      projectId: null,
      goalId: null,
      heartbeatRunId: "run-1",
      billingCode: null,
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costCents: 34,
      occurredAt: currentMonthDate(),
    });

    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "cost_event",
        rootExecutionId: "run-1",
        agentId: "agent-1",
        issueId: "issue-1",
      }),
      expect.objectContaining({
        name: "cost.ingested",
      }),
    );
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(3);
    expect(tx.update).toHaveBeenCalledTimes(4);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      spentMonthlyCents: 12,
    }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      spentMonthlyCents: 34,
    }));
  });

  it("does not add out-of-month cost events to current monthly spend fields", async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(costEventInsertChain({
          id: "cost-previous-month",
          orgId: "org-1",
          agentId: "agent-1",
          issueId: null,
          heartbeatRunId: null,
          provider: "openai",
          model: "gpt-4.1",
          biller: "openai",
          billingType: "metered_api",
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          costCents: 99,
          occurredAt: previousMonthDate(),
        })),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { scopeType: "agent", scopeId: "agent-1", spendCents: 12 },
            { scopeType: "organization", scopeId: "org-1", spendCents: 34 },
          ]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: updateSet,
      }),
    };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "agent-1", orgId: "org-1" }])),
      transaction: vi.fn((callback) => callback(tx)),
    };

    const svc = costService(db as never);
    await svc.createEvent("org-1", {
      agentId: "agent-1",
      issueId: null,
      projectId: null,
      goalId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costCents: 99,
      occurredAt: previousMonthDate(),
    });

    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      spentMonthlyCents: 12,
    }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      spentMonthlyCents: 34,
    }));
  });

  it("reconciles missing current monthly rollups when ingesting out-of-month cost events", async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce(costEventInsertChain({
          id: "cost-previous-month",
          orgId: "org-1",
          agentId: "agent-1",
          issueId: null,
          heartbeatRunId: null,
          provider: "openai",
          model: "gpt-4.1",
          biller: "openai",
          billingType: "metered_api",
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          costCents: 99,
          occurredAt: previousMonthDate(),
        }))
        .mockReturnValueOnce(rollupInsertChain([{ spendCents: 12 }]))
        .mockReturnValueOnce(rollupInsertChain([{ spendCents: 34 }])),
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ spendCents: 12 }]))
        .mockReturnValueOnce(selectChain([{ spendCents: 34 }])),
      update: vi.fn().mockReturnValue({
        set: updateSet,
      }),
    };
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "agent-1", orgId: "org-1" }])),
      transaction: vi.fn((callback) => callback(tx)),
    };

    const svc = costService(db as never);
    await svc.createEvent("org-1", {
      agentId: "agent-1",
      issueId: null,
      projectId: null,
      goalId: null,
      heartbeatRunId: null,
      billingCode: null,
      provider: "openai",
      model: "gpt-4.1",
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      costCents: 99,
      occurredAt: previousMonthDate(),
    });

    expect(tx.select).toHaveBeenCalledTimes(3);
    expect(tx.insert).toHaveBeenCalledTimes(3);
    expect(updateSet).toHaveBeenNthCalledWith(1, expect.objectContaining({
      spentMonthlyCents: 12,
    }));
    expect(updateSet).toHaveBeenNthCalledWith(2, expect.objectContaining({
      spentMonthlyCents: 34,
    }));
  });
});
