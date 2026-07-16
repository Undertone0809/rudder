import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatClientCheckpointKey,
  createChatClientCheckpointDispatcher,
  type ChatClientCheckpoint,
} from "./chat-client-checkpoints";

function checkpoint(generationSeq: number): ChatClientCheckpoint {
  return {
    chatId: "chat-1",
    generationId: "generation-1",
    attemptEpoch: 2,
    generationSeq,
    renderedBodyHash: `${generationSeq}`.padStart(64, "a").slice(-64),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chat client checkpoint dispatcher", () => {
  it("coalesces rapid visible renders to the newest sequence", async () => {
    const submit = vi.fn(async () => undefined);
    const dispatcher = createChatClientCheckpointDispatcher(submit, { debounceMs: 20 });

    dispatcher.enqueue(checkpoint(1));
    dispatcher.enqueue(checkpoint(2));
    dispatcher.enqueue(checkpoint(3));
    await vi.advanceTimersByTimeAsync(20);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(checkpoint(3));
    dispatcher.dispose();
  });

  it("sends a newer checkpoint after an older request finishes", async () => {
    let resolveFirst!: () => void;
    const submit = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const dispatcher = createChatClientCheckpointDispatcher(submit, { debounceMs: 10 });

    dispatcher.enqueue(checkpoint(4));
    await vi.advanceTimersByTimeAsync(10);
    dispatcher.enqueue(checkpoint(5));
    resolveFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(submit.mock.calls.map(([value]) => value.generationSeq)).toEqual([4, 5]);
    dispatcher.dispose();
  });

  it("retries an unacknowledged checkpoint without advancing its sequence", async () => {
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const dispatcher = createChatClientCheckpointDispatcher(submit, {
      debounceMs: 5,
      retryMs: 25,
    });

    dispatcher.enqueue(checkpoint(8));
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersByTimeAsync(25);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[0]).toEqual(checkpoint(8));
    expect(submit.mock.calls[1]?.[0]).toEqual(checkpoint(8));
    dispatcher.dispose();
  });

  it("drops timers for generations that are no longer visible", async () => {
    const submit = vi.fn(async () => undefined);
    const dispatcher = createChatClientCheckpointDispatcher(submit, { debounceMs: 20 });
    const pending = checkpoint(11);
    const otherGeneration = {
      ...checkpoint(12),
      generationId: "generation-2",
    };

    dispatcher.enqueue(pending);
    dispatcher.retain(new Set([chatClientCheckpointKey(otherGeneration)]));
    await vi.advanceTimersByTimeAsync(20);

    expect(submit).not.toHaveBeenCalled();
    dispatcher.dispose();
  });
});
