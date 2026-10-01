import { describe, expect, it, vi } from "vitest";
import { createChatAssistantExecutionOwner } from "./chat-assistant.execution-owner.js";

describe("Chat dependent failure finalization", () => {
  it("aborts a prepared native intent before releasing the Run owner on observer failure", async () => {
    const events: string[] = [];
    const failure = new Error("submission reconciliation failed after span sealing");
    const beforeFinalize = vi.fn(async (state: string) => {
      expect(state).toBe("failed");
      events.push("intent_unknown");
    });
    const owner = createChatAssistantExecutionOwner({
      ownerSignal: new AbortController().signal,
      beforeFinalize,
      failureState: () => "failed",
      finalize: async () => { events.push("run_finalized"); },
    });
    await expect(owner.guard(async () => { throw failure; })).rejects.toBe(failure);
    expect(events).toEqual(["intent_unknown", "run_finalized"]);
    await owner.finalizeUnhandledFailure(failure);
    expect(beforeFinalize).toHaveBeenCalledOnce();
  });

  it("does not finalize the Run when its dependent fenced abort fails", async () => {
    const finalize = vi.fn();
    const abortFailure = new Error("intent abort CAS lost");
    const owner = createChatAssistantExecutionOwner({
      ownerSignal: new AbortController().signal,
      beforeFinalize: async () => { throw abortFailure; },
      failureState: () => "failed",
      finalize,
    });
    await expect(owner.guard(async () => { throw new Error("observer failed"); }))
      .rejects.toBe(abortFailure);
    expect(finalize).not.toHaveBeenCalled();
    expect(owner.isFinalized()).toBe(false);
  });

  it("does not mutate dependent state after losing Run ownership", async () => {
    const controller = new AbortController();
    const beforeFinalize = vi.fn();
    const finalize = vi.fn();
    const owner = createChatAssistantExecutionOwner({
      ownerSignal: controller.signal,
      beforeFinalize,
      failureState: () => "failed",
      finalize,
    });
    controller.abort();
    await owner.finalizeUnhandledFailure(new Error("stale result"));
    expect(beforeFinalize).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("runs the fenced cleanup before a requested Stop finalizes the Run", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const events: string[] = [];
    const owner = createChatAssistantExecutionOwner({
      ownerSignal: new AbortController().signal, stopSignal: stopped.signal,
      beforeFinalize: async () => { events.push("intent_unknown"); },
      failureState: () => "failed",
      finalize: async () => { events.push("run_stopped"); },
    });
    await owner.finalize("stopped");
    expect(events).toEqual(["intent_unknown", "run_stopped"]);
  });

  it("does not finalize after losing ownership while dependent cleanup awaits", async () => {
    const controller = new AbortController();
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const finalize = vi.fn();
    const owner = createChatAssistantExecutionOwner({
      ownerSignal: controller.signal,
      beforeFinalize: () => cleanup,
      failureState: () => "failed",
      finalize,
    });
    const pending = owner.finalize("failed");
    controller.abort();
    releaseCleanup();
    await expect(pending).rejects.toThrow("execution owner was lost");
    expect(finalize).not.toHaveBeenCalled();
  });
});
