import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopBrowserRuntimeLifecycle } from "./browser-runtime-lifecycle.js";
import { stopDesktopRuntime } from "./desktop-runtime-shutdown.js";

describe("Desktop runtime shutdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("disconnects the Browser before stopping an owned runtime", async () => {
    const lifecycle: string[] = [];
    await stopDesktopRuntime({
      browserDisconnect: vi.fn(async () => { lifecycle.push("browser:disconnect"); }),
      runtimeHandle: {
        runtime: { mode: "owned" },
        stop: vi.fn(async () => { lifecycle.push("runtime:stop"); }),
      },
    });

    expect(lifecycle).toEqual(["browser:disconnect", "runtime:stop"]);
  });

  it("still stops an owned runtime when Browser disconnect never settles", async () => {
    const stop = vi.fn(async () => undefined);
    const onWarning = vi.fn();
    const onBrowserDisconnectTimeout = vi.fn();
    const shutdown = stopDesktopRuntime({
      browserDisconnect: vi.fn(() => new Promise<void>(() => undefined)),
      browserDisconnectTimeoutMs: 25,
      runtimeHandle: { runtime: { mode: "owned" }, stop },
      onBrowserDisconnectTimeout,
      onWarning,
    });

    await vi.advanceTimersByTimeAsync(25);
    await shutdown;

    expect(onWarning).toHaveBeenCalledWith(
      "Browser runtime disconnect timed out after 25ms; continuing with runtime shutdown.",
    );
    expect(onBrowserDisconnectTimeout).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("never stops an attached runtime after Browser disconnect timeout", async () => {
    const stop = vi.fn(async () => undefined);
    const shutdown = stopDesktopRuntime({
      browserDisconnect: vi.fn(() => new Promise<void>(() => undefined)),
      browserDisconnectTimeoutMs: 25,
      runtimeHandle: { runtime: { mode: "attached" }, stop },
    });

    await vi.advanceTimersByTimeAsync(25);
    await shutdown;

    expect(stop).not.toHaveBeenCalled();
  });

  it("reports a disconnect rejection and continues owned runtime shutdown", async () => {
    const error = new Error("broker close failed");
    const stop = vi.fn(async () => undefined);
    const onWarning = vi.fn();

    await stopDesktopRuntime({
      browserDisconnect: vi.fn(async () => { throw error; }),
      runtimeHandle: { runtime: { mode: "owned" }, stop },
      onWarning,
    });

    expect(onWarning).toHaveBeenCalledWith(
      "Browser runtime disconnect failed; continuing with runtime shutdown.",
      error,
    );
    expect(stop).toHaveBeenCalledOnce();
  });

  it("can rotate a timed-out Browser lifecycle and reconnect on the replacement", async () => {
    const createLifecycle = (brokerStop: () => Promise<void>) => {
      const registerBroker = vi.fn(async () => undefined);
      const lifecycle = createDesktopBrowserRuntimeLifecycle({
        tabs: {
          execute: vi.fn(async () => ({})),
          closeAll: vi.fn(async () => undefined),
          reapInactiveRuns: vi.fn(async () => undefined),
        },
        getProfileEnabled: () => true,
        setProfileEnabled: vi.fn(async () => undefined),
        execute: vi.fn(async () => ({})),
        startBroker: vi.fn(async () => ({
          endpoint: "http://127.0.0.1:43123/browser",
          token: "a".repeat(64),
          stop: brokerStop,
        })),
        registerBroker,
        unregisterBroker: vi.fn(async () => undefined),
        readSettings: vi.fn(async () => ({ enabled: true, openLinksIn: "built_in" as const })),
        isRunActive: vi.fn(async () => true),
        sweepIntervalMs: 60_000,
      });
      return { lifecycle, registerBroker };
    };

    const poisoned = createLifecycle(() => new Promise<void>(() => undefined));
    const replacement = createLifecycle(async () => undefined);
    let current = poisoned;
    await poisoned.lifecycle.connect("http://127.0.0.1:3100/api");
    const stop = vi.fn(async () => undefined);
    const shutdown = stopDesktopRuntime({
      browserDisconnect: () => current.lifecycle.disconnect(),
      browserDisconnectTimeoutMs: 25,
      onBrowserDisconnectTimeout: () => { current = replacement; },
      runtimeHandle: { runtime: { mode: "owned" }, stop },
    });

    await vi.advanceTimersByTimeAsync(25);
    await shutdown;
    await current.lifecycle.connect("http://127.0.0.1:3200/api");

    expect(stop).toHaveBeenCalledOnce();
    expect(current).toBe(replacement);
    expect(replacement.registerBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3200/api",
      expect.any(Object),
      undefined,
    );
    await replacement.lifecycle.disconnect();
  });

  it("fences an old Broker whose start settles after lifecycle replacement", async () => {
    let generation = 0;
    let registered: { token: string; generation: number } | null = null;
    const registrations: Array<{ token: string; generation: number }> = [];
    let releaseOldStart!: () => void;
    const oldStartGate = new Promise<void>((resolve) => { releaseOldStart = resolve; });
    let markOldStartEntered!: () => void;
    const oldStartEntered = new Promise<void>((resolve) => { markOldStartEntered = resolve; });
    const oldBrokerStop = vi.fn(async () => undefined);
    const createLifecycle = (
      token: string,
      options: { startGate?: Promise<void>; onStartEntered?: () => void; brokerStop?: () => Promise<void> } = {},
    ) => createDesktopBrowserRuntimeLifecycle({
        tabs: {
          execute: vi.fn(async () => ({})),
          closeAll: vi.fn(async () => undefined),
          reapInactiveRuns: vi.fn(async () => undefined),
        },
        getProfileEnabled: () => true,
        setProfileEnabled: vi.fn(async () => undefined),
        execute: vi.fn(async () => ({})),
        startBroker: vi.fn(async () => {
          options.onStartEntered?.();
          await options.startGate;
          return {
            endpoint: "http://127.0.0.1:43001/browser",
            token,
            stop: options.brokerStop ?? vi.fn(async () => undefined),
          };
        }),
        allocateRegistrationGeneration: () => ++generation,
        registerBroker: vi.fn(async (_apiUrl, broker, registrationGeneration) => {
          if (registrationGeneration === undefined) throw new Error("missing generation");
          if (registered && registered.generation > registrationGeneration) {
            throw new Error("stale desktop lifecycle");
          }
          registrations.push({ token: broker.token, generation: registrationGeneration });
          registered = { token: broker.token, generation: registrationGeneration };
        }),
        unregisterBroker: vi.fn(async (_apiUrl, unregisterToken) => {
          if (registered?.token === unregisterToken) registered = null;
        }),
        readSettings: vi.fn(async () => ({ enabled: true, openLinksIn: "built_in" as const })),
        isRunActive: vi.fn(async () => true),
        sweepIntervalMs: 60_000,
      });

    const oldLifecycle = createLifecycle("o".repeat(64), {
      startGate: oldStartGate,
      onStartEntered: markOldStartEntered,
      brokerStop: oldBrokerStop,
    });
    const oldConnect = oldLifecycle.connect("http://127.0.0.1:3100/api");
    expect(generation).toBe(1);
    await oldStartEntered;
    let current = oldLifecycle;
    let oldDisconnect: Promise<void> | null = null;
    const shutdown = stopDesktopRuntime({
      browserDisconnect: () => {
        oldDisconnect = current.disconnect();
        return oldDisconnect;
      },
      browserDisconnectTimeoutMs: 25,
      onBrowserDisconnectTimeout: () => { current = createLifecycle("n".repeat(64)); },
      runtimeHandle: { runtime: { mode: "owned" }, stop: vi.fn(async () => undefined) },
    });

    await vi.advanceTimersByTimeAsync(25);
    await shutdown;
    await current.connect("http://127.0.0.1:3200/api");
    expect(generation).toBe(2);
    expect(registered).toEqual({ token: "n".repeat(64), generation: 2 });

    releaseOldStart();
    await oldConnect;
    if (!oldDisconnect) throw new Error("Expected the timed-out disconnect to remain in flight");
    await oldDisconnect;
    expect(oldBrokerStop).toHaveBeenCalledOnce();
    expect(registrations).toEqual([{ token: "n".repeat(64), generation: 2 }]);
    expect(registered).toEqual({ token: "n".repeat(64), generation: 2 });
    await current.disconnect();
  });
});
