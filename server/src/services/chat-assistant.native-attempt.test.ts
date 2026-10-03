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

function callbacks(options: { stopped?: boolean; ownerLost?: boolean; fallbackAllowed?: boolean } = {}) {
  const controller = new AbortController();
  if (options.stopped) controller.abort();
  const markAcceptanceUnknown = vi.fn(async () => ({ checkpointed: true }));
  const recordNativeExecutionResult = vi.fn(async (
    _result: AgentRuntimeExecutionResult,
    fence: { spanId?: string | null; attemptId?: string | null },
  ) => ({
    id: fence.spanId ?? "",
    attemptRef: { id: fence.attemptId ?? "", attemptIndex: 0 },
  }));
  const onAttemptResult = vi.fn(async () => undefined);
  const beforeTerminalNativeResult = vi.fn(async (result: AgentRuntimeExecutionResult) => ({
    ...result, sessionDisplayId: "normalized-child",
  }));
  const prepareNativeFallback = vi.fn(async () => options.fallbackAllowed !== false);
  const handlers = createChatNativeAttemptCallbacks({
    orgId: "org-1",
    runtimeAgentType: "codex_local",
    isNativeRuntime: (runtimeType) => runtimeType === "codex_local",
    signal: controller.signal,
    isExecutionInactive: () => Boolean(options.stopped || options.ownerLost),
    isOwnerLost: () => options.ownerLost === true,
    ownerLostError: new Error("owner lost"),
    getAttempt: () => ({ id: "attempt-1", attemptIndex: 0 }),
    getSpanFence: () => ({ spanId: "span-1", ownerToken: "owner-1", attemptEpoch: 2 }),
    markAcceptanceUnknown,
    beforeTerminalNativeResult,
    prepareNativeFallback,
    recordNativeExecutionResult,
    onAttemptResult,
  });
  return { handlers, markAcceptanceUnknown, beforeTerminalNativeResult, prepareNativeFallback, recordNativeExecutionResult, onAttemptResult };
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
  it("records the current writer exit after Stop without admitting another dispatch", async () => {
    const current = callbacks({ stopped: true });
    await expect(current.handlers.onAttemptSubmissionStart(attempt)).rejects.toThrow("owner lost");
    const result: AgentRuntimeExecutionResult = {
      exitCode: null, signal: "SIGTERM", timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    };
    await current.handlers.onAttemptResult(attempt, result, "accepted");
    expect(current.recordNativeExecutionResult).toHaveBeenCalledWith({ ...result, sessionDisplayId: "normalized-child" },
      expect.objectContaining({ spanId: "span-1", attemptId: "attempt-1", attemptEpoch: 2 }));
    expect(current.markAcceptanceUnknown).not.toHaveBeenCalled();
  });

  it("rejects a returning result after ownership is lost even if Stop was also requested", async () => {
    const current = callbacks({ stopped: true, ownerLost: true });
    await expect(current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission"))
      .rejects.toThrow("owner lost");
    expect(current.recordNativeExecutionResult).not.toHaveBeenCalled();
  });

  it("checkpoints dispatch and records its exact attempt/span before downstream fallback handling", async () => {
    const current = callbacks();
    await current.handlers.onAttemptSubmissionStart(attempt);
    expect(current.markAcceptanceUnknown).toHaveBeenCalledWith(expect.objectContaining({
      phase: "indeterminate",
      reason: expect.stringContaining("attemptId=attempt-1; spanId=span-1"),
    }));

    await current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission",
      { providerDispatched: false, willFallback: true });
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
    await expect(current.handlers.onAttemptResult(attempt, preSubmissionResult(false), "pre_submission",
      { providerDispatched: true, willFallback: true }))
      .rejects.toThrow("native writer is confirmed quiescent");
    expect(current.recordNativeExecutionResult).toHaveBeenCalledOnce();
    expect(current.onAttemptResult).not.toHaveBeenCalled();
  });

  it("does not require native writer proof for a non-native previous attempt", async () => {
    const current = callbacks();
    const result: AgentRuntimeExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "openclaw_gateway_request_failed",
      errorMessage: "Primary gateway request failed",
    };
    await expect(current.handlers.onAttemptResult(
      { ...attempt, agentRuntimeType: "openclaw_gateway" },
      result,
      "accepted",
      { providerDispatched: true, willFallback: true },
    )).resolves.toBeUndefined();
    expect(current.recordNativeExecutionResult).toHaveBeenCalledOnce();
    expect(current.onAttemptResult).toHaveBeenCalledOnce();
  });

  it("rejects results whose current durable attempt does not match the provider callback", async () => {
    const current = callbacks();
    await expect(current.handlers.onAttemptSubmissionStart({ ...attempt, index: 1 }))
      .rejects.toThrow("matching durable attempt and native span");
    expect(current.markAcceptanceUnknown).not.toHaveBeenCalled();
  });

  it("does not finalize a Fork intent for an attempt that will fall back", async () => {
    const current = callbacks();
    await current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission",
      { providerDispatched: false, willFallback: true });
    expect(current.beforeTerminalNativeResult).not.toHaveBeenCalled();
    expect(current.recordNativeExecutionResult).toHaveBeenCalledOnce();
  });

  it("finalizes the terminal Fork outcome before sealing and records its normalized identity", async () => {
    const current = callbacks();
    const result: AgentRuntimeExecutionResult = {
      exitCode: 0, signal: null, timedOut: false, sessionId: "child", submissionPhase: "accepted",
    };
    await current.handlers.onAttemptResult(attempt, result, "accepted");
    expect(current.beforeTerminalNativeResult).toHaveBeenCalledWith(result,
      expect.objectContaining({ spanId: "span-1", attemptId: "attempt-1", ownerToken: "owner-1" }));
    expect(current.beforeTerminalNativeResult.mock.invocationCallOrder[0])
      .toBeLessThan(current.recordNativeExecutionResult.mock.invocationCallOrder[0]!);
    expect(current.recordNativeExecutionResult).toHaveBeenCalledWith(
      { ...result, sessionDisplayId: "normalized-child" }, expect.any(Object));
  });

  it("treats Stop as terminal instead of admitting a fallback", async () => {
    const current = callbacks({ stopped: true });
    await current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission");
    expect(current.beforeTerminalNativeResult).toHaveBeenCalledOnce();
  });

  it("finalizes auth-exhausted attempts even when unused fallback models remain", async () => {
    const current = callbacks();
    await current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission",
      { providerDispatched: true, willFallback: false });
    expect(current.beforeTerminalNativeResult).toHaveBeenCalledOnce();
    expect(current.prepareNativeFallback).not.toHaveBeenCalled();
  });

  it("records terminal intent and native writer state before refusing an unsafe Fork retry", async () => {
    const current = callbacks({ fallbackAllowed: false });
    await expect(current.handlers.onAttemptResult(attempt, preSubmissionResult(true), "pre_submission",
      { providerDispatched: true, willFallback: true }))
      .rejects.toThrow("without proof that no child was created");
    expect(current.beforeTerminalNativeResult).toHaveBeenCalledOnce();
    expect(current.recordNativeExecutionResult).toHaveBeenCalledOnce();
    expect(current.onAttemptResult).toHaveBeenCalledOnce();
    expect(current.beforeTerminalNativeResult.mock.invocationCallOrder[0])
      .toBeLessThan(current.recordNativeExecutionResult.mock.invocationCallOrder[0]!);
  });
});
