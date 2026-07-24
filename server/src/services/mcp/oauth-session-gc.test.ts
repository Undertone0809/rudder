import { describe, expect, it, vi } from "vitest";
import { startManagedMcpOAuthSessionGc } from "./oauth-session-gc.js";

describe("managed MCP OAuth session GC", () => {
  it("runs a bounded startup sweep, repeats, unreferences its timer, and stops cleanly", async () => {
    const cleanupExpiredSessions = vi.fn().mockResolvedValue(3);
    const timer = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setInterval>;
    let tick: (() => void) | undefined;
    const setIntervalFn = vi.fn((callback: () => void) => {
      tick = callback;
      return timer;
    });
    const clearIntervalFn = vi.fn();

    const gc = startManagedMcpOAuthSessionGc(
      { cleanupExpiredSessions },
      {
        batchSize: 25,
        intervalMs: 1_000,
        setIntervalFn,
        clearIntervalFn,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cleanupExpiredSessions).toHaveBeenCalledWith(undefined, 25);
    expect(timer.unref).toHaveBeenCalledOnce();

    tick?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupExpiredSessions).toHaveBeenCalledTimes(2);

    gc.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  it("does not overlap cleanup sweeps and reports failures without stopping the timer", async () => {
    let release!: () => void;
    const firstSweep = new Promise<number>((resolve) => {
      release = () => resolve(1);
    });
    const cleanupError = new Error("database unavailable");
    const cleanupExpiredSessions = vi.fn()
      .mockReturnValueOnce(firstSweep)
      .mockRejectedValueOnce(cleanupError)
      .mockResolvedValue(0);
    let tick: (() => void) | undefined;
    const errors: unknown[] = [];
    const gc = startManagedMcpOAuthSessionGc(
      { cleanupExpiredSessions },
      {
        intervalMs: 1_000,
        setIntervalFn: (callback) => {
          tick = callback;
          return { unref() {} } as ReturnType<typeof setInterval>;
        },
        clearIntervalFn: () => {},
        onError: (error) => errors.push(error),
      },
    );

    tick?.();
    expect(cleanupExpiredSessions).toHaveBeenCalledOnce();
    release();
    await firstSweep;
    await new Promise<void>((resolve) => setImmediate(resolve));
    tick?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupExpiredSessions).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([cleanupError]);
    tick?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cleanupExpiredSessions).toHaveBeenCalledTimes(3);
    gc.stop();
  });
});
