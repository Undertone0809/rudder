import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudderhq/shared";
import { getRunListSummary } from "./AgentDetail.runs";

function run(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "00000000-0000-4000-8000-000000000000",
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
    createdAt: new Date("2026-05-24T12:00:00.000Z"),
    updatedAt: new Date("2026-05-24T12:00:00.000Z"),
    ...overrides,
  };
}

describe("getRunListSummary", () => {
  it("does not expose failed run result JSON summaries", () => {
    expect(getRunListSummary(run({
      status: "failed",
      error: "Adapter failed",
      resultJson: { summary: "Raw adapter failure: token abc123" },
    }))).toBe("The run hit a system-level execution problem. Rudder saved the technical details for diagnostics.");
  });

  it("keeps successful run summaries visible", () => {
    expect(getRunListSummary(run({
      status: "succeeded",
      resultJson: { summary: "Updated the implementation plan" },
    }))).toBe("Updated the implementation plan");
  });

  it("describes cancelled runs as cancelled instead of failed", () => {
    expect(getRunListSummary(run({
      status: "cancelled",
      error: "Cancelled because the linked issue is no longer actionable",
      errorCode: "cancelled",
    }))).toBe("The run was cancelled before it could continue. Rudder kept the cancellation reason for context.");
  });
});
