import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudderhq/shared";
import { describeRunReason } from "./run-reason";

function makeRun(overrides: Partial<HeartbeatRun>): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "queued",
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
    createdAt: new Date("2026-04-27T00:00:00.000Z"),
    updatedAt: new Date("2026-04-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("describeRunReason", () => {
  it("uses heartbeat language for scheduled timer runs", () => {
    expect(describeRunReason(makeRun({
      invocationSource: "timer",
      triggerDetail: "system",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    })).label).toBe("Scheduled heartbeat");
  });

  it("shows passive follow-up attempts instead of automation", () => {
    const reason = describeRunReason(makeRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        wakeReason: "issue_passive_followup",
        passiveFollowup: {
          originRunId: "run-0",
          previousRunId: "run-1",
          attempt: 1,
          maxAttempts: 2,
          reason: "missing_closure",
          queuedAt: "2026-04-27T00:00:00.000Z",
        },
      },
    }));

    expect(reason.label).toBe("Follow-up 1/2");
    expect(reason.description).toContain("clear close-out");
  });

  it("shows comment and mention reasons instead of the backend source", () => {
    expect(describeRunReason(makeRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { wakeReason: "issue_commented" },
    })).label).toBe("Comment added");

    expect(describeRunReason(makeRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { wakeReason: "issue_comment_mentioned" },
    })).label).toBe("Mentioned");
  });

  it("shows recovery and retry reasons", () => {
    expect(describeRunReason(makeRun({
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: {
        wakeReason: "process_lost_retry",
        recovery: {
          originalRunId: "run-0",
          failureKind: "process_lost",
          failureSummary: "Process lost",
          recoveryTrigger: "automatic",
          recoveryMode: "continue_preferred",
        },
      },
    })).label).toBe("Recovery");

    expect(describeRunReason(makeRun({
      invocationSource: "on_demand",
      triggerDetail: "manual",
      retryOfRunId: "run-0",
      contextSnapshot: { wakeReason: "retry_failed_run" },
    })).label).toBe("Retry");
  });
});
