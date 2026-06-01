import { describe, expect, it, vi } from "vitest";

const mockAnalyzeRunIfEnabled = vi.hoisted(() => vi.fn());
const mockReleaseRuntimeServicesForRun = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/run-diagnostics.js", () => ({
  runDiagnosticsService: () => ({
    analyzeRunIfEnabled: mockAnalyzeRunIfEnabled,
  }),
}));

vi.mock("../langfuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../langfuse.js")>();
  return {
    ...actual,
    withExecutionObservation: async (_context: unknown, _options: unknown, callback: (observation: unknown) => Promise<void>) =>
      callback({}),
    updateExecutionObservation: vi.fn(),
    updateExecutionTraceIO: vi.fn(),
    updateExecutionTraceName: vi.fn(),
    updateExecutionTraceSession: vi.fn(),
  };
});

vi.mock("../services/workspace-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workspace-runtime.js")>();
  return {
    ...actual,
    releaseRuntimeServicesForRun: mockReleaseRuntimeServicesForRun,
  };
});

import { createHeartbeatExecuteHandlers } from "../services/runtime-kernel/heartbeat.execute.js";

describe("heartbeat run diagnostics scheduling", () => {
  it("schedules diagnostics for setup-failed completed runs when analysis is enabled", async () => {
    let observedEnabled = false;
    mockAnalyzeRunIfEnabled.mockImplementation(async (_runId: string, isEnabled: () => Promise<boolean>) => {
      observedEnabled = await isEnabled();
      return [];
    });

    const run = {
      id: "run-1",
      agentId: "agent-1",
      wakeupRequestId: "wakeup-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: {},
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
    };
    const failedRun = {
      ...run,
      status: "failed",
      error: "setup exploded",
      errorCode: "adapter_failed",
    };

    const context = {
      db: {},
      instanceSettings: {
        getGeneral: vi.fn(async () => ({ analyzeCompletedAgentRuns: true })),
      },
      activeRunExecutions: new Set<string>(),
      getRun: vi.fn()
        .mockResolvedValueOnce(run)
        .mockResolvedValueOnce(failedRun),
      getAgent: vi.fn(async () => ({
        id: "agent-1",
        orgId: "org-1",
        name: "Builder",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      })),
      buildHeartbeatObservabilityContext: vi.fn(() => ({
        runId: "run-1",
        sessionKey: null,
        metadata: {},
      })),
      ensureRuntimeState: vi.fn(async () => {
        throw new Error("setup exploded");
      }),
      setRunStatus: vi.fn(async () => undefined),
      setWakeupStatus: vi.fn(async () => undefined),
      appendRunEvent: vi.fn(async () => undefined),
      emitHeartbeatLiveEval: vi.fn(async () => undefined),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
      startNextQueuedRunForAgent: vi.fn(async () => undefined),
    };

    const { executeRun } = createHeartbeatExecuteHandlers(context);

    await executeRun("run-1");

    expect(context.setRunStatus).toHaveBeenCalledWith("run-1", "failed", expect.objectContaining({
      error: "setup exploded",
      errorCode: "adapter_failed",
    }));
    expect(mockAnalyzeRunIfEnabled).toHaveBeenCalledWith("run-1", expect.any(Function));
    expect(observedEnabled).toBe(true);
    expect(context.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(failedRun);
    expect(mockReleaseRuntimeServicesForRun).toHaveBeenCalledWith("run-1");
  });
});
