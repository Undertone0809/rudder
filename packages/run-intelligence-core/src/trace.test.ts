import { describe, expect, it } from "vitest";
import { buildObservedRunTrace } from "./trace.js";
import { observedRunFromFilesystem } from "./loaders/rudder.js";

describe("buildObservedRunTrace", () => {
  it("keeps tool payloads compact in previews while preserving full detail", () => {
    const detail = observedRunFromFilesystem({
      run: {
        id: "run-trace-1",
        orgId: "org-1",
        agentId: "agent-1",
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        startedAt: new Date("2026-04-08T10:00:00.000Z"),
        finishedAt: new Date("2026-04-08T10:01:00.000Z"),
        error: null,
        wakeupRequestId: null,
        exitCode: 0,
        signal: null,
        usageJson: { inputTokens: 10, outputTokens: 20, costUsd: 0.12 },
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: "local_file",
        logRef: "trace.ndjson",
        logBytes: 100,
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
        contextSnapshot: {},
        createdAt: new Date("2026-04-08T10:00:00.000Z"),
        updatedAt: new Date("2026-04-08T10:01:00.000Z"),
      },
      agentName: "Trace Agent",
      bundle: {
        agentRuntimeType: "codex_local",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      logContent: "",
    });

    detail.transcript = [
      { kind: "system", ts: "2026-04-08T10:00:00.000Z", text: "booted" },
      { kind: "assistant", ts: "2026-04-08T10:00:01.000Z", text: "I will inspect the codebase." },
      {
        kind: "tool_call",
        ts: "2026-04-08T10:00:02.000Z",
        name: "Read",
        input: { filePath: "/tmp/big-file.ts" },
      },
      {
        kind: "tool_result",
        ts: "2026-04-08T10:00:03.000Z",
        toolUseId: "tool-1",
        toolName: "Read",
        content: "first line\nsecond line\nthird line",
        isError: false,
      },
      {
        kind: "result",
        ts: "2026-04-08T10:00:04.000Z",
        text: "",
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
        costUsd: 0.12,
        subtype: "completed",
        isError: false,
        errors: [],
      },
    ];

    const trace = buildObservedRunTrace(detail);
    expect(trace.looseSteps).toHaveLength(1);
    expect(trace.turns).toHaveLength(1);
    expect(trace.turns[0]?.toolCallCount).toBe(1);
    expect(trace.turns[0]?.summary).toContain("I will inspect the codebase.");

    const toolResultStep = trace.steps.find((step) => step.kind === "tool_result");
    expect(toolResultStep?.detailPreview).toBe("first line");
    expect(toolResultStep?.detailText).toContain("second line");
    expect(toolResultStep?.hasExpandableDetail).toBe(true);
  });
});
