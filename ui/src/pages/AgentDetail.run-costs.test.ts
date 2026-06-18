import type { CostTrendPoint, HeartbeatRun } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { summarizeCostTrendUsage, summarizeRunCostUsage } from "./AgentDetail.helpers";

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
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
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-06-18T12:00:00.000Z"),
    updatedAt: new Date("2026-06-18T12:00:00.000Z"),
    ...overrides,
  };
}

describe("summarizeRunCostUsage", () => {
  it("aggregates only the runs passed by the current date range", () => {
    const summary = summarizeRunCostUsage([
      run({
        id: "run-in-range",
        usageJson: {
          inputTokens: 1_000,
          cachedInputTokens: 400,
          outputTokens: 50,
          costUsd: 0.012,
        },
      }),
    ]);

    expect(summary).toEqual({
      promptTokens: 1_000,
      outputTokens: 50,
      cachedInputTokens: 400,
      totalCostCents: 1,
      hasUsage: true,
    });
  });

  it("treats subscription-included run costs as zero while keeping token usage", () => {
    const summary = summarizeRunCostUsage([
      run({
        usageJson: {
          inputTokens: 2_000,
          cachedInputTokens: 1_500,
          outputTokens: 100,
          costUsd: 2.5,
          billingType: "subscription_included",
        },
      }),
    ]);

    expect(summary).toMatchObject({
      promptTokens: 2_000,
      outputTokens: 100,
      cachedInputTokens: 1_500,
      totalCostCents: 0,
      hasUsage: true,
    });
  });
});

describe("summarizeCostTrendUsage", () => {
  it("aggregates the server-side trend rows for the selected date range", () => {
    const rows: CostTrendPoint[] = [
      {
        date: "2026-06-17",
        costCents: 12,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 100,
        totalTokens: 1_100,
        eventCount: 2,
      },
      {
        date: "2026-06-18",
        costCents: 5,
        inputTokens: 500,
        cachedInputTokens: 100,
        outputTokens: 50,
        totalTokens: 550,
        eventCount: 1,
      },
    ];

    expect(summarizeCostTrendUsage(rows)).toEqual({
      promptTokens: 1_500,
      outputTokens: 150,
      cachedInputTokens: 350,
      totalCostCents: 17,
      hasUsage: true,
    });
  });
});
