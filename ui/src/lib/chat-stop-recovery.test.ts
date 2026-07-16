import type { ChatStreamDraft } from "@/context/ChatGenerationContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingChatStopRecovery,
  createChatStopRecoveryRetrier,
  createPendingChatStopRecovery,
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

  it("drops stale recovery records instead of replaying an old generation fence", () => {
    savePendingChatStopRecovery(createPendingChatStopRecovery({
      orgId: "org-1",
      chatId: "chat-1",
      request: { controlActionId: "20000000-0000-4000-8000-000000000001" },
      frozenDraft: streamDraft(),
      now: new Date("2026-07-14T01:00:00.000Z"),
    }));

    expect(readPendingChatStopRecovery(
      "org-1",
      "chat-1",
      new Date("2026-07-16T01:00:01.000Z"),
    )).toBeNull();
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
