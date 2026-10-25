import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingChatStopRecovery,
  createChatStopRecoveryRetrier,
  createPendingChatStopRecovery,
  hasCompleteNativeStopFence,
  hydrateIncompleteNativeChatStopRecovery,
  readPendingChatStopRecovery,
  savePendingChatStopRecovery,
} from "./chat-stop-recovery";

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, value)),
    removeItem: vi.fn((key: string) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    get length() {
      return store.size;
    },
  } as Storage;
}

function streamDraft(): ChatStreamDraft {
  return {
    chatId: "chat-1",
    streamKey: "stream-1",
    userBody: "Draft a plan",
    userCreatedAt: new Date("2026-07-16T01:00:00.000Z"),
    userMessageId: "message-1",
    chatTurnId: "turn-1",
    turnVariant: 0,
    editedFromCreatedAt: null,
    body: "Frozen visible prefix",
    generationId: "generation-1",
    attemptEpoch: 2,
    lastCommittedRenderSeq: 9,
    renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    state: "streaming",
    createdAt: new Date("2026-07-16T01:00:01.000Z"),
    transcript: [],
    replyingAgentId: "agent-1",
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat Stop recovery", () => {
  it("round-trips the exact action and frozen render checkpoint", () => {
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: {
        controlActionId: "20000000-0000-4000-8000-000000000001",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
        expectedControlVersion: 7,
        lastCommittedRenderSeq: 9,
        renderedBodyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      frozenDraft: streamDraft(),
      now: new Date("2026-07-16T01:00:02.000Z"),
    });

    savePendingChatStopRecovery(recovery);

    expect(readPendingChatStopRecovery(
      "org-1",
      "chat-1",
      new Date("2026-07-16T01:00:03.000Z"),
    )).toEqual(recovery);
  });

  it("hydrates an incomplete old action only from its original Native target", () => {
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: {
        controlActionId: "old-stop-action",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
      },
      frozenDraft: null,
    });
    const hydrated = hydrateIncompleteNativeChatStopRecovery(recovery, {
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-1",
      generationId: "generation-1",
      attemptEpoch: 2,
      controlVersion: 8,
      lastClientCheckpointSeq: 4,
      lastClientCheckpointHash: "b".repeat(64),
      lastSequence: 5,
      runtimeTerminal: false,
    }, "e".repeat(64));

    expect(hydrated?.request).toEqual({
      controlActionId: "old-stop-action",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 8,
      lastCommittedRenderSeq: 4,
      renderedBodyHash: "b".repeat(64),
    });
    expect(hydrated?.executionAuthority).toBe("native_rust");
  });

  it.each([
    {
      label: "a newer generation",
      recovery: createPendingChatStopRecovery({
        orgId: "org-1", chatId: "chat-1",
        request: { controlActionId: "old-action", expectedGenerationId: "generation-1", expectedAttemptEpoch: 2 },
        frozenDraft: null,
      }),
      controlGenerationId: "generation-2",
      controlAttemptEpoch: 2,
    },
    {
      label: "a newer attempt",
      recovery: createPendingChatStopRecovery({
        orgId: "org-1", chatId: "chat-1",
        request: { controlActionId: "old-action", expectedGenerationId: "generation-1", expectedAttemptEpoch: 2 },
        frozenDraft: null,
      }),
      controlGenerationId: "generation-1",
      controlAttemptEpoch: 3,
    },
    {
      label: "the current run when the old target was not stored",
      recovery: createPendingChatStopRecovery({
        orgId: "org-1", chatId: "chat-1",
        request: { controlActionId: "old-action" },
        frozenDraft: null,
      }),
      controlGenerationId: "generation-2",
      controlAttemptEpoch: 1,
    },
  ])("does not retarget an incomplete action to $label", ({ recovery, controlGenerationId, controlAttemptEpoch }) => {
    expect(hydrateIncompleteNativeChatStopRecovery(recovery, {
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-1",
      generationId: controlGenerationId,
      attemptEpoch: controlAttemptEpoch,
      controlVersion: 9,
      lastClientCheckpointSeq: null,
      lastClientCheckpointHash: null,
      lastSequence: 0,
      runtimeTerminal: false,
    }, "e".repeat(64))).toBeNull();
  });

  it("refuses to synthesize an empty cutoff over a visible saved response", () => {
    const draft = streamDraft();
    delete draft.lastCommittedRenderSeq;
    delete draft.renderedBodyHash;
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: {
        controlActionId: "old-stop-action",
        expectedGenerationId: "generation-1",
        expectedAttemptEpoch: 2,
      },
      frozenDraft: draft,
    });
    expect(hydrateIncompleteNativeChatStopRecovery(recovery, {
      executionAuthority: "native_rust",
      orgId: "org-1",
      conversationId: "chat-1",
      generationId: "generation-1",
      attemptEpoch: 2,
      controlVersion: 8,
      lastClientCheckpointSeq: null,
      lastClientCheckpointHash: null,
      lastSequence: 9,
      runtimeTerminal: false,
    }, "e".repeat(64))).toBeNull();
  });

  it("recognizes a complete saved fence for exact replay", () => {
    expect(hasCompleteNativeStopFence({
      controlActionId: "saved-action",
      expectedGenerationId: "generation-1",
      expectedAttemptEpoch: 2,
      expectedControlVersion: 8,
      lastCommittedRenderSeq: 4,
      renderedBodyHash: "b".repeat(64),
    })).toBe(true);
  });

  it("keeps organizations and chats isolated when clearing", () => {
    for (const [orgId, chatId] of [["org-1", "chat-1"], ["org-1", "chat-2"], ["org-2", "chat-1"]]) {
      savePendingChatStopRecovery(createPendingChatStopRecovery({
        orgId,
        chatId,
        request: { controlActionId: `${orgId}:${chatId}` },
        frozenDraft: null,
      }));
    }

    clearPendingChatStopRecovery("org-1", "chat-1");

    expect(readPendingChatStopRecovery("org-1", "chat-1")).toBeNull();
    expect(readPendingChatStopRecovery("org-1", "chat-2")).not.toBeNull();
    expect(readPendingChatStopRecovery("org-2", "chat-1")).not.toBeNull();
  });

  it("drops stale explicitly legacy recovery records", () => {
    savePendingChatStopRecovery(createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: { controlActionId: "20000000-0000-4000-8000-000000000001" },
      frozenDraft: streamDraft(),
      executionAuthority: "legacy_ts",
      now: new Date("2026-07-14T01:00:00.000Z"),
    }));

    expect(readPendingChatStopRecovery(
      "org-1",
      "chat-1",
      new Date("2026-07-16T01:00:01.000Z"),
    )).toBeNull();
  });

  it.each(["native_rust", undefined] as const)("retains unresolved %s Stop identity after 24 hours", (executionAuthority) => {
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1", chatId: "chat-1", executionAuthority,
      request: { controlActionId: "20000000-0000-4000-8000-000000000001", expectedGenerationId: "generation-1" },
      frozenDraft: streamDraft(), now: new Date("2026-07-14T01:00:00.000Z"),
    });
    savePendingChatStopRecovery(recovery);
    expect(readPendingChatStopRecovery("org-1", "chat-1", new Date("2026-07-16T01:00:01.000Z"))).toEqual(recovery);
  });

  it("does not let an older acknowledgement clear a newer Stop action", () => {
    const newerRecovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: { controlActionId: "20000000-0000-4000-8000-000000000002" },
      frozenDraft: streamDraft(),
    });
    savePendingChatStopRecovery(newerRecovery);

    expect(clearPendingChatStopRecovery(
      "org-1",
      "chat-1",
      "20000000-0000-4000-8000-000000000001",
    )).toBe(false);
    expect(readPendingChatStopRecovery("org-1", "chat-1")).toEqual(newerRecovery);
  });

  it("caps automatic retry backoff and preserves the same action", async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: { controlActionId: "20000000-0000-4000-8000-000000000001" },
      frozenDraft: streamDraft(),
    });
    const retrier = createChatStopRecoveryRetrier(retry, { retryDelaysMs: [10, 20] });

    retrier.schedule(recovery);
    await vi.advanceTimersByTimeAsync(10);
    expect(retry).toHaveBeenLastCalledWith(recovery);

    retrier.schedule(recovery);
    await vi.advanceTimersByTimeAsync(20);
    retrier.schedule(recovery);
    await vi.advanceTimersByTimeAsync(19);
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(retry.mock.calls.every(([candidate]) => (
      candidate.request.controlActionId === recovery.request.controlActionId
    ))).toBe(true);

    retrier.dispose();
  });

  it("lets a terminal event preempt a scheduled retry", async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const recovery = createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: { controlActionId: "20000000-0000-4000-8000-000000000001" },
      frozenDraft: streamDraft(),
    });
    const retrier = createChatStopRecoveryRetrier(retry, { retryDelaysMs: [100] });

    retrier.schedule(recovery);
    retrier.retryNow(recovery);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(retry).toHaveBeenCalledTimes(1);

    retrier.dispose();
  });
});
