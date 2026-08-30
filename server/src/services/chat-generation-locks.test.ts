import type {
  AgentRuntimeControlHandle,
  AgentRuntimeControlSteerResult,
} from "@rudderhq/agent-runtime-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelActiveChatGeneration,
  claimChatGeneration,
  clearActiveChatGenerationsForTest,
  createChatRuntimeControlCoordinator,
  getActiveChatGeneration,
  steerActiveChatGeneration,
} from "./chat-generation-locks.js";

function controlHandle(
  patch: Partial<AgentRuntimeControlHandle> = {},
): AgentRuntimeControlHandle {
  return {
    runtimeType: "codex_local",
    providerThreadId: "thread-1",
    providerTurnId: "turn-1",
    capabilities: {
      steer: "native",
      interrupt: "native",
    },
    steer: vi.fn(async () => ({
      disposition: "accepted_current" as const,
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    })),
    interrupt: vi.fn(async () => "acknowledged" as const),
    dispose: vi.fn(async () => undefined),
    ...patch,
  };
}

describe("chat generation runtime controls", () => {
  afterEach(() => {
    clearActiveChatGenerationsForTest();
  });

  it("publishes the active send mutation while a generation is starting", () => {
    const releaseGeneration = claimChatGeneration(
      "chat-1",
      new AbortController(),
      null,
      "send-mutation-1",
    );

    expect(getActiveChatGeneration("chat-1")).toMatchObject({
      clientMutationId: "send-mutation-1",
      lifecycle: "starting",
    });
    releaseGeneration?.();
  });

  it("invalidates and disposes the prior attempt before publishing a fallback handle", async () => {
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    expect(releaseGeneration).not.toBeNull();
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const firstAttempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const firstHandle = controlHandle();
    const firstHandleLease = await firstAttempt.register(firstHandle);
    expect(firstHandleLease?.isCurrent()).toBe(true);

    const secondAttempt = await coordinator.beginAttempt({
      attemptIndex: 1,
      runtimeType: "codex_local",
      model: "gpt-backup",
      isFallback: true,
    });

    expect(firstHandleLease?.isCurrent()).toBe(false);
    expect(firstHandle.dispose).toHaveBeenCalledTimes(1);
    const lateHandle = controlHandle();
    await expect(firstAttempt.register(lateHandle)).resolves.toBeNull();
    expect(lateHandle.dispose).toHaveBeenCalledTimes(1);

    const secondHandle = controlHandle({ providerTurnId: "turn-2" });
    const secondHandleLease = await secondAttempt.register(secondHandle);
    expect(secondHandleLease?.isCurrent()).toBe(true);
    expect(getActiveChatGeneration("chat-1")).toMatchObject({
      generationId: "generation-1",
      attemptEpoch: 2,
      lifecycle: "running",
      runtimeType: "codex_local",
    });

    await secondAttempt.complete();
    expect(secondHandle.dispose).toHaveBeenCalledTimes(1);
    expect(secondHandleLease?.isCurrent()).toBe(false);
    releaseGeneration?.();
  });

  it("delivers native steer to the active attempt and preserves provider receipt evidence", async () => {
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const handle = controlHandle();
    await attempt.register(handle);

    const result = await steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      feedback: { text: "Use the public API instead", clientMessageId: "control-1" },
    });

    expect(result).toEqual({
      status: "delivered_current",
      disposition: "accepted_current",
      attemptEpoch: 1,
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    });
    expect(handle.steer).toHaveBeenCalledWith({
      text: "Use the public API instead",
      clientMessageId: "control-1",
    });
    releaseGeneration?.();
  });

  it("delivers pending Steer as soon as the matching control handle is ready", async () => {
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
    });

    const claimProviderSend = vi.fn(async () => ({
      clientMessageId: "provider-control-1",
      release: vi.fn(async () => undefined),
    }));
    let settled = false;
    const pendingSteer = steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      feedback: { text: "Wait for control", clientMessageId: "control-1" },
      claimProviderSend,
    }).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(claimProviderSend).not.toHaveBeenCalled();
    await expect(steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-old",
      feedback: { text: "Do not retarget", clientMessageId: "control-2" },
    })).resolves.toEqual({
      status: "stale_generation",
      activeGenerationId: "generation-1",
    });
    const handle = controlHandle();
    await attempt.register(handle);
    await expect(pendingSteer).resolves.toMatchObject({
      status: "delivered_current",
      attemptEpoch: 1,
    });
    expect(claimProviderSend).toHaveBeenCalledTimes(1);
    expect(handle.steer).toHaveBeenCalledWith({
      text: "Wait for control",
      clientMessageId: "provider-control-1",
    });
    releaseGeneration?.();
  });

  it("bounds pre-handle Steer registration wait without claiming provider send", async () => {
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
    });
    const claimProviderSend = vi.fn();

    await expect(steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 1,
      feedback: { text: "Do not wait forever", clientMessageId: "control-1" },
      claimProviderSend,
      registrationWaitMs: 5,
    })).resolves.toEqual({
      status: "continuation_required",
      attemptEpoch: 1,
      reason: "registration_timeout",
    });
    expect(claimProviderSend).not.toHaveBeenCalled();
    releaseGeneration?.();
  });

  it("does not call the provider when the durable generation fence denies the send", async () => {
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
    });
    const handle = controlHandle();
    await attempt.register(handle);

    await expect(steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 1,
      feedback: { text: "Do not cross the Stop cutoff", clientMessageId: "control-1" },
      claimProviderSend: async () => ({
        sendDenied: true,
        reason: "generation_fence_changed",
      }),
    })).resolves.toEqual({
      status: "continuation_required",
      attemptEpoch: 1,
      reason: "generation_fence_changed",
    });
    expect(handle.steer).not.toHaveBeenCalled();
    releaseGeneration?.();
  });

  it("releases a claimed provider send when attempt ownership changes before send", async () => {
    let resolveClaim!: (claim: {
      clientMessageId: string;
      release(): Promise<void>;
    }) => void;
    const releaseClaim = vi.fn(async () => undefined);
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const firstAttempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const firstHandle = controlHandle();
    await firstAttempt.register(firstHandle);
    const claimProviderSend = vi.fn(() => new Promise<{
      clientMessageId: string;
      release(): Promise<void>;
    }>((resolve) => {
      resolveClaim = resolve;
    }));

    const pendingSteer = steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 1,
      feedback: { text: "Fence the old attempt", clientMessageId: "control-1" },
      claimProviderSend,
    });
    await vi.waitFor(() => expect(claimProviderSend).toHaveBeenCalledTimes(1));
    await coordinator.beginAttempt({
      attemptIndex: 1,
      runtimeType: "codex_local",
      model: "gpt-fallback",
      isFallback: true,
    });
    resolveClaim({ clientMessageId: "provider-control-1", release: releaseClaim });

    await expect(pendingSteer).resolves.toEqual({
      status: "continuation_required",
      attemptEpoch: 1,
      reason: "owner_changed_before_send",
    });
    expect(releaseClaim).toHaveBeenCalledTimes(1);
    expect(firstHandle.steer).not.toHaveBeenCalled();
    releaseGeneration?.();
  });

  it("turns pending pre-handle Steer into a continuation when Stop wins", async () => {
    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration("chat-1", abortController, "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
    });
    const pendingSteer = steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      feedback: { text: "Continue after Stop", clientMessageId: "control-1" },
    });

    expect(cancelActiveChatGeneration("chat-1")).toBe(true);
    await expect(pendingSteer).resolves.toEqual({
      status: "continuation_required",
      attemptEpoch: 1,
      reason: "closing",
    });
    const lateHandle = controlHandle();
    await expect(attempt.register(lateHandle)).resolves.toBeNull();
    expect(lateHandle.steer).not.toHaveBeenCalled();
    releaseGeneration?.();
  });

  it("linearizes Stop before provider interruption and rejects later control publication", async () => {
    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration("chat-1", abortController, "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const handle = controlHandle();
    await attempt.register(handle);

    expect(cancelActiveChatGeneration("chat-1")).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(getActiveChatGeneration("chat-1")?.lifecycle).toBe("stopping");
    await vi.waitFor(() => expect(handle.interrupt).toHaveBeenCalledWith("operator_stop"));
    await expect(steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      feedback: { text: "Too late", clientMessageId: "control-1" },
    })).resolves.toEqual({
      status: "continuation_required",
      attemptEpoch: 1,
      reason: "closing",
    });

    const lateHandle = controlHandle();
    await expect(attempt.register(lateHandle)).resolves.toBeNull();
    expect(lateHandle.dispose).toHaveBeenCalledTimes(1);
    releaseGeneration?.();
  });

  it("preserves a late provider acknowledgement as evidence after Stop wins locally", async () => {
    let acknowledge!: (value: {
      disposition: "accepted_current";
      providerThreadId: string;
      providerTurnId: string;
    }) => void;
    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration("chat-1", abortController, "generation-1");
    const coordinator = createChatRuntimeControlCoordinator("chat-1", "generation-1");
    const attempt = await coordinator.beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const handle = controlHandle({
      steer: vi.fn(() => new Promise<AgentRuntimeControlSteerResult>((resolve) => {
        acknowledge = resolve;
      })),
    });
    await attempt.register(handle);

    const steerPromise = steerActiveChatGeneration({
      conversationId: "chat-1",
      expectedGenerationId: "generation-1",
      feedback: { text: "Use the public API", clientMessageId: "control-1" },
    });
    await vi.waitFor(() => expect(handle.steer).toHaveBeenCalledTimes(1));
    expect(cancelActiveChatGeneration("chat-1")).toBe(true);
    acknowledge({
      disposition: "accepted_current",
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    });

    await expect(steerPromise).resolves.toMatchObject({
      status: "delivered_current",
      ownerChangedAfterSend: true,
    });
    releaseGeneration?.();
  });
});
