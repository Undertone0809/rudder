import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopComputerRuntimeLifecycle } from "./computer-runtime-lifecycle.js";

function createHarness() {
  let enabled = false;
  let ready = false;
  let execute: ((command: never) => Promise<unknown>) | null = null;
  const broker = {
    endpoint: "http://127.0.0.1:4111/computer",
    token: "a".repeat(48),
    stop: vi.fn(async () => undefined),
  };
  const runtime = {
    execute: vi.fn(async () => ({ ok: true })),
    reapInactiveRuns: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  const readReadiness = vi.fn(async () => ({
    supported: true,
    accessibility: ready,
    screenRecording: ready,
    actionReady: ready,
    driverVersion: ready ? "0.19.2" : null,
    reason: ready ? null : "permissions required",
  }));
  const registerBroker = vi.fn(async () => undefined);
  const unregisterBroker = vi.fn(async () => undefined);
  const onWarning = vi.fn();
  const lifecycle = createDesktopComputerRuntimeLifecycle({
    runtime,
    readSettings: vi.fn(async () => ({ experimentalComputerUseEnabled: enabled })),
    readReadiness,
    isRunActive: vi.fn(async () => true),
    startBroker: vi.fn(async (input) => {
      execute = input.execute as typeof execute;
      return broker;
    }),
    allocateGeneration: () => 1,
    registerBroker,
    unregisterBroker,
    pollIntervalMs: 1_000,
    onWarning,
  });
  return {
    broker,
    lifecycle,
    readReadiness,
    registerBroker,
    runtime,
    setEnabled: (value: boolean) => { enabled = value; },
    setReady: (value: boolean) => { ready = value; },
    unregisterBroker,
    invoke: (value: never) => execute?.(value),
    onWarning,
  };
}

describe("Desktop Computer runtime lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not load the driver permission module while the experiment is disabled", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    expect(harness.readReadiness).not.toHaveBeenCalled();
    expect(harness.registerBroker).not.toHaveBeenCalled();
  });

  it("starts only when enabled and permission-ready, then revokes on disable", async () => {
    const harness = createHarness();
    harness.setEnabled(true);
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    expect(harness.registerBroker).not.toHaveBeenCalled();

    harness.setReady(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.registerBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker,
      1,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.runtime.reapInactiveRuns).toHaveBeenCalledTimes(1);

    harness.setEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
    expect(harness.runtime.shutdown).toHaveBeenCalled();
  });

  it("keeps the Broker live when an inactive-Run sweep cannot reach the Server", async () => {
    const harness = createHarness();
    harness.setEnabled(true);
    harness.setReady(true);
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.broker.stop.mockClear();
    harness.runtime.shutdown.mockClear();
    harness.runtime.reapInactiveRuns.mockRejectedValueOnce(new Error("status unavailable"));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.broker.stop).not.toHaveBeenCalled();
    expect(harness.runtime.shutdown).not.toHaveBeenCalled();
    expect(harness.onWarning).toHaveBeenCalledWith(
      "Computer Run cleanup failed.",
      expect.objectContaining({ message: "status unavailable" }),
    );
  });
});
