import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudder/shared";
import { diagnoseRun } from "./diagnosis.js";
import { buildLangfuseRunScores } from "./langfuse-scores.js";
import { observedRunFromFilesystem } from "./loaders/rudder.js";

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    orgId: "org-1",
    agentId: "agent-1",
    invocationSource: "on_demand",
    triggerDetail: "manual",
    status: "failed",
    startedAt: new Date("2026-04-08T10:00:00.000Z"),
    finishedAt: new Date("2026-04-08T10:02:00.000Z"),
    error: "budget hard limit exceeded",
    wakeupRequestId: null,
    exitCode: 1,
    signal: null,
    usageJson: { inputTokens: 42, outputTokens: 12, costUsd: 0.12 },
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: "local_file",
    logRef: "run-1.ndjson",
    logBytes: 100,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: "budget hard limit exceeded",
    errorCode: "budget_limit",
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: { issueId: "issue-1" },
    createdAt: new Date("2026-04-08T10:00:00.000Z"),
    updatedAt: new Date("2026-04-08T10:02:00.000Z"),
    ...overrides,
  };
}

describe("buildLangfuseRunScores", () => {
  it("maps phase-1 score taxonomy from run diagnosis", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun(),
      agentName: "Budget Agent",
      issue: { id: "issue-1", identifier: "RUD-1", title: "Protect the budget" },
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      events: [
        {
          id: 1,
          orgId: "org-1",
          runId: "run-1",
          agentId: "agent-1",
          seq: 1,
          eventType: "error",
          stream: "system",
          level: "error",
          color: null,
          message: "budget hard limit exceeded",
          payload: null,
          createdAt: new Date("2026-04-08T10:02:00.000Z"),
        },
      ],
      logContent: "",
    });

    const diagnosis = diagnoseRun(detail, "error");
    const scores = buildLangfuseRunScores(detail, diagnosis);

    expect(scores.map((score) => score.name)).toEqual([
      "run_health",
      "failure_taxonomy",
      "task_outcome",
      "budget_guardrail",
      "cost_efficiency",
      "human_intervention_required",
    ]);
    expect(scores.find((score) => score.name === "run_health")?.value).toBe(false);
    expect(scores.find((score) => score.name === "budget_guardrail")?.value).toBe(true);
    expect(scores.find((score) => score.name === "human_intervention_required")?.value).toBe(true);
  });

  it("includes recovery_success when a recovery run is present", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun({
        status: "succeeded",
        error: null,
        errorCode: null,
        contextSnapshot: {
          issueId: "issue-1",
          recovery: {
            originalRunId: "run-0",
            failureKind: "adapter_failed",
            failureSummary: "Previous run failed",
            recoveryTrigger: "automatic",
            recoveryMode: "continue_preferred",
          },
        },
      }),
      agentName: "Recovery Agent",
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      logContent: "",
    });

    const diagnosis = diagnoseRun(detail, "auto");
    const scores = buildLangfuseRunScores(detail, diagnosis);

    expect(scores.find((score) => score.name === "recovery_success")).toMatchObject({
      value: true,
    });
  });
});
