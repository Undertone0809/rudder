import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatBackgroundRuntime } from "../routes/chat-background-runtime.js";

describe("ChatBackgroundRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes idempotently, cancels timers, aborts owned execution, and waits for in-flight work", async () => {
    vi.useFakeTimers();
    const runtime = createChatBackgroundRuntime();
    const managedAbort = runtime.manageAbortController();
    let finishWork!: () => void;
    const finishClaimedWork = vi.fn();
    const work = new Promise<void>((resolve) => {
      finishWork = () => {
        finishClaimedWork();
        resolve();
      };
    });
    const activeTask = vi.fn(() => work);
    const cancelledTask = vi.fn();
    const intervalTask = vi.fn();

    runtime.setTimeout(activeTask, 0);
    runtime.setTimeout(cancelledTask, 10);
    runtime.setInterval(intervalTask, 5);
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    expect(activeTask).toHaveBeenCalledOnce();

    const firstClose = runtime.close();
    const duplicateClose = runtime.close();
    expect(duplicateClose).toBe(firstClose);
    expect(runtime.acceptingWork).toBe(false);
    expect(managedAbort.controller.signal.aborted).toBe(true);
    expect(runtime.setTimeout(vi.fn(), 0)).toBeNull();

    vi.advanceTimersByTime(20);
    expect(cancelledTask).not.toHaveBeenCalled();
    expect(intervalTask).not.toHaveBeenCalled();

    let closed = false;
    void firstClose.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishWork();
    await firstClose;
    expect(finishClaimedWork).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });

  it("supports a fresh owner after same-process close without reviving old scheduled work", async () => {
    vi.useFakeTimers();
    const firstRuntime = createChatBackgroundRuntime();
    const firstTask = vi.fn();
    firstRuntime.setTimeout(firstTask, 0);
    await firstRuntime.close();

    const secondRuntime = createChatBackgroundRuntime();
    const secondTask = vi.fn();
    secondRuntime.setTimeout(secondTask, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(firstTask).not.toHaveBeenCalled();
    expect(secondTask).toHaveBeenCalledOnce();
    expect(secondRuntime.acceptingWork).toBe(true);
    await secondRuntime.close();
  });

  it("coalesces duplicate wakes and reruns once after active work completes", async () => {
    vi.useFakeTimers();
    const runtime = createChatBackgroundRuntime();
    let finishFirstRun!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    const task = vi.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const runner = runtime.createCoalescingTask(task, vi.fn());

    runner.wake();
    runner.wake();
    vi.advanceTimersByTime(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(task).toHaveBeenCalledOnce();

    runner.wake();
    finishFirstRun();
    await Promise.resolve();
    await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    expect(task).toHaveBeenCalledTimes(2);

    await runtime.close();
  });
});
