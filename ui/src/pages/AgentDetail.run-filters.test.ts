import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudderhq/shared";
import {
  applyRunFilters,
  parseRunFilterState,
  runFilterChips,
  writeRunFilterState,
} from "./AgentDetail.run-filters";

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

describe("agent run filters", () => {
  it("parses and writes URL query state without dropping unrelated params", () => {
    const original = new URLSearchParams("tab=runs&runView=failed&runStatus=failed,timed_out&runContext=retry&runQ=process");
    const state = parseRunFilterState(original);

    expect(state.view).toBe("failed");
    expect(state.statuses).toEqual(["failed", "timed_out"]);
    expect(state.contexts).toEqual(["retry"]);
    expect(state.q).toBe("process");

    const next = writeRunFilterState(original, {
      view: "all",
      q: "",
      statuses: [],
      contexts: [],
    });

    expect(next.get("tab")).toBe("runs");
    expect(next.get("runView")).toBeNull();
    expect(next.get("runStatus")).toBeNull();
    expect(next.get("runContext")).toBeNull();
    expect(next.get("runQ")).toBeNull();
  });

  it("filters by attention, issue context, retry context, token cost, and search text", () => {
    const normal = run({
      id: "11111111-0000-4000-8000-000000000000",
      resultJson: { summary: "Finished ordinary run" },
    });
    const issueRetry = run({
      id: "22222222-0000-4000-8000-000000000000",
      status: "failed",
      errorCode: "process_lost",
      retryOfRunId: "11111111-0000-4000-8000-000000000000",
      contextSnapshot: {
        issueId: "issue-1",
        recovery: {
          originalRunId: "11111111-0000-4000-8000-000000000000",
          failureKind: "process_lost",
          failureSummary: "Process lost",
          recoveryTrigger: "manual",
          recoveryMode: "continue_preferred",
        },
      },
      usageJson: {
        inputTokens: 600_000,
        cachedInputTokens: 100_000,
        outputTokens: 25_000,
      },
      resultJson: { summary: "Process lost on launch" },
    });

    const filtered = applyRunFilters([normal, issueRetry], {
      view: "attention",
      q: "launch",
      statuses: ["failed"],
      sources: [],
      contexts: ["issue", "retry", "process_lost"],
      date: "all",
      cost: ["high_tokens"],
    });

    expect(filtered.map((item) => item.id)).toEqual([issueRetry.id]);
  });

  it("describes active filter chips for the floating toolbar", () => {
    const chips = runFilterChips({
      view: "issue",
      q: "ZST-289",
      statuses: ["succeeded"],
      sources: ["assignment"],
      contexts: ["followup"],
      date: "7d",
      cost: ["long"],
    });

    expect(chips).toEqual([
      "Issue work",
      "Search: ZST-289",
      "Status: Succeeded",
      "Source: Assignment",
      "Passive follow-up",
      ">30m",
      "7d",
    ]);
  });
});
