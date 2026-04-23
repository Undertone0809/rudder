import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@rudder/shared";
import { diagnoseRun } from "./diagnosis.js";
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
    error: "permission denied",
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
    stderrExcerpt: "permission denied",
    errorCode: "permission_denied",
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

describe("diagnoseRun", () => {
  it("classifies a known error taxonomy", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun(),
      agentName: "Debugger",
      issue: { id: "issue-1", identifier: "RUD-1", title: "Fix the service" },
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      logContent: "",
    });

    const diagnosis = diagnoseRun(detail, "error");
    expect(diagnosis.failureTaxonomy).toBe("permission_denied");
    expect(diagnosis.findings.some((finding) => finding.id === "taxonomy-permission_denied")).toBe(true);
  });

  it("reports performance warnings for very large runs", () => {
    const detail = observedRunFromFilesystem({
      run: makeRun({
        status: "succeeded",
        error: null,
        errorCode: null,
        usageJson: { inputTokens: 700000, outputTokens: 12000, costUsd: 8.5 },
        startedAt: new Date("2026-04-08T10:00:00.000Z"),
        finishedAt: new Date("2026-04-08T10:20:00.000Z"),
      }),
      agentName: "Perf Agent",
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      logContent: "",
    });

    const diagnosis = diagnoseRun(detail, "perf");
    expect(diagnosis.findings.some((finding) => finding.id === "duration-over-10m")).toBe(true);
    expect(diagnosis.findings.some((finding) => finding.id === "very-high-input-tokens")).toBe(true);
  });
});
