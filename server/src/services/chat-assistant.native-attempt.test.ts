import type {
  AgentRuntimeExecutionResult,
  ModelAttemptSpec,
} from "@rudderhq/agent-runtime-utils";
import { describe, expect, it, vi } from "vitest";
import { createChatNativeAttemptCallbacks } from "./chat-assistant.native-attempt.js";

const attempt: ModelAttemptSpec = {
  index: 0,
  agentRuntimeType: "codex_local",
  model: "primary",
  config: null,
  isFallback: false,
  fallbackIndex: null,
  totalFallbacks: 1,
};

function callbacks() {
  const markAcceptanceUnknown = vi.fn(async () => ({ checkpointed: true }));
  const recordNativeExecutionResult = vi.fn(async (
    _result: AgentRuntimeExecutionResult,
    fence: { spanId?: string | null; attemptId?: string | null },
  ) => ({
    id: fence.spanId ?? "",
    attemptRef: { id: fence.attemptId ?? "", attemptIndex: 0 },
  }));
  const onAttemptResult = vi.fn(async () => undefined);
  const handlers = createChatNativeAttemptCallbacks({
    orgId: "org-1",
    runtimeAgentType: "codex_local",
    nativeDriverRequired: true,
    signal: new AbortController().signal,
    isExecutionInactive: () => false,
    ownerLostError: new Error("owner lost"),
    getAttempt: () => ({ id: "attempt-1", attemptIndex: 0 }),
    getSpanFence: () => ({ spanId: "span-1", ownerToken: "owner-1", attemptEpoch: 2 }),
    markAcceptanceUnknown,
    recordNativeExecutionResult,
    onAttemptResult,
  });
  return { handlers, markAcceptanceUnknown, recordNativeExecutionResult, onAttemptResult };
}

function preSubmissionResult(quiescent: boolean): AgentRuntimeExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: "provider_unavailable",
    errorMessage: "Provider was not submitted",
    submissionPhase: "pre_submission",
    ...(quiescent ? { nativeWriterQuiescence: { status: "confirmed", source: "not_started" } } : {}),
  };
}

describe("Chat native attempt lifecycle callbacks", () => {
  it("checkpoints dispatch and records its exact attempt/span before downstream fallback handling", async () => {
    const current = callbacks();
    await current.handlers.onAttemptSubmissionStart(attempt);
    expect(current.markAcceptanceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      phase: "indeterminate",
      reason: expect.stringContaining("attemptId=attempt-1; spanId=span-1"),
    }));

    await current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission");
    expect(current.recordNativeExecutionResult).toHaveBeenCalledWith(
      expect.objectContaining({ nativeWriterQuiescence: { status: "confirmed", source: "not_started" } }),
      expect.objectContaining({ orgId: "org-1", spanId: "span-1", attemptId: "attempt-1", attemptEpoch: 2 }),
    );
    expect(current.recordNativeExecutionResult.mock.invocationCallOrder[0])
      .toBeLessThan(current.onAttemptResult.mock.invocationCallOrder[0]!);
    expect(current.onAttemptResult).toHaveBeenCalledOnce();
  });

  it("does not permit fallback handling until the exact native writer is quiescent", async () => {
    const current = callbacks();
    await expect(current.handlers.onAttemptResult(attempt, preSubmissionResult(false), "pre_submission"))
      .rejects.toThrow("native writer is confirmed quiescent");
    expect(current.recordNativeExecutionResult).toHaveBeenCalledOnce();
    expect(current.onAttemptResult).not.toHaveBeenCalled();
  });

  it("rejects results whose current durable attempt does not match the provider callback", async () => {
    const current = callbacks();
    await expect(current.handlers.onAttemptSubmissionStart({ ...attempt, index: 1 }))
      .rejects.toThrow("matching durable attempt and native span");
    expect(current.markAcceptanceUnknown).not.toHaveBeenCalled();
  });
});
