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

describe("costService Langfuse export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a detached cost event when tied to a heartbeat run", async () => {
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce(selectChain([{ id: "agent-1", orgId: "org-1" }]))
        .mockReturnValueOnce(selectChain([{ total: 12 }]))
        .mockReturnValueOnce(selectChain([{ total: 34 }])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            {
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
            },
          ]),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
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
      occurredAt: new Date("2026-04-12T00:00:00.000Z"),
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
  });
});
