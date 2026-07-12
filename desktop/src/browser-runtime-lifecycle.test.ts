import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesktopBrowserRuntimeLifecycle } from "./browser-runtime-lifecycle.js";

const identity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };

function createHarness(options: {
  closeAllFails?: boolean;
  registrationFails?: boolean;
  unregisterFails?: boolean;
  registrationGate?: Promise<void>;
} = {}) {
  const broker = {
    endpoint: "http://127.0.0.1:43123/browser",
    token: "a".repeat(64),
    stop: vi.fn(async () => undefined),
  };
  let enabled = true;
  const tabs = {
    execute: vi.fn(async () => ({ ok: true })),
    closeAll: options.closeAllFails
      ? vi.fn(async () => { throw new Error("tab cleanup failed"); })
      : vi.fn(async () => undefined),
    reapInactiveRuns: vi.fn(async (isRunActive: (value: typeof identity) => Promise<boolean>) => {
      await isRunActive(identity);
    }),
  };
  const registerBroker = vi.fn(async () => {
    await options.registrationGate;
    if (options.registrationFails) throw new Error("registration failed");
  });
  const unregisterBroker = options.unregisterFails
    ? vi.fn(async () => { throw new Error("unregister failed"); })
    : vi.fn(async () => undefined);
  const readSettings = vi.fn(async () => ({ enabled: false, openLinksIn: "built_in" as const }));
  const setProfileEnabled = vi.fn(async (value: boolean) => { enabled = value; });
  const isRunActive = vi.fn(async () => true);
  const onWarning = vi.fn();
  let brokerExecute: ((command: any) => Promise<unknown>) | null = null;
  const lifecycle = createDesktopBrowserRuntimeLifecycle({
    tabs,
    getProfileEnabled: () => enabled,
    setProfileEnabled,
    execute: tabs.execute,
    startBroker: vi.fn(async (input) => {
      brokerExecute = input.execute;
      return broker;
    }),
    registerBroker,
    unregisterBroker,
    readSettings,
    isRunActive,
    sweepIntervalMs: 1_000,
    onWarning,
  });
  return {
    broker,
    executeBrokerCommand: (command: any) => {
      if (!brokerExecute) throw new Error("Broker was not started");
      return brokerExecute(command);
    },
    isRunActive,
    lifecycle,
    onWarning,
    readSettings,
    registerBroker,
    setProfileEnabled,
    tabs,
    unregisterBroker,
  };
}

describe("Desktop Browser runtime lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("syncs initial settings, registers the Broker, and reaps inactive runs", async () => {
    const harness = createHarness();

    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    expect(harness.setProfileEnabled).toHaveBeenCalledWith(false);
    expect(harness.registerBroker).toHaveBeenCalledWith("http://127.0.0.1:3100/api", harness.broker);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.tabs.reapInactiveRuns).toHaveBeenCalledTimes(1);
    expect(harness.isRunActive).toHaveBeenCalledWith("http://127.0.0.1:3100/api", identity);
  });

  it("unregisters, stops, and closes leases before reconnecting or disconnecting", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    await harness.lifecycle.connect("http://127.0.0.1:3200/api");
    expect(harness.unregisterBroker).toHaveBeenCalledWith("http://127.0.0.1:3100/api", harness.broker.token);
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
    expect(harness.tabs.closeAll).toHaveBeenCalledTimes(2);

    await harness.lifecycle.disconnect();
    expect(harness.unregisterBroker).toHaveBeenLastCalledWith("http://127.0.0.1:3200/api", harness.broker.token);
    expect(harness.broker.stop).toHaveBeenCalledTimes(2);
    expect(harness.tabs.closeAll).toHaveBeenCalledTimes(3);
  });

  it("rolls back a Broker that the local runtime rejects", async () => {
    const harness = createHarness({ registrationFails: true });

    await expect(harness.lifecycle.connect("http://127.0.0.1:3100/api"))
      .rejects.toThrow("registration failed");
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
  });

  it("continues Broker shutdown when native tab cleanup fails", async () => {
    const harness = createHarness({ closeAllFails: true });
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    await expect(harness.lifecycle.disconnect()).resolves.toBeUndefined();
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
    expect(harness.onWarning).toHaveBeenCalledWith(
      "Rudder Browser tab cleanup failed.",
      expect.any(Error),
    );
  });

  it("continues shutdown when unregister fails", async () => {
    const harness = createHarness({ unregisterFails: true });
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    await expect(harness.lifecycle.disconnect()).resolves.toBeUndefined();
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
    expect(harness.tabs.closeAll).toHaveBeenCalled();
    expect(harness.onWarning).toHaveBeenCalledWith(
      "Rudder Browser Broker unregister failed.",
      expect.any(Error),
    );
  });

  it("stops admitting commands synchronously when disconnect begins", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    const disconnecting = harness.lifecycle.disconnect();

    await expect(harness.executeBrokerCommand({
      identity,
      action: "tabs",
      args: {},
    })).rejects.toMatchObject({ code: "browser_unavailable" });
    await disconnecting;
    expect(harness.tabs.execute).not.toHaveBeenCalled();
  });

  it("unregisters a Broker whose registration finishes after disconnect starts", async () => {
    let releaseRegistration!: () => void;
    const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
    const harness = createHarness({ registrationGate });
    const connecting = harness.lifecycle.connect("http://127.0.0.1:3100/api");
    await vi.waitFor(() => expect(harness.registerBroker).toHaveBeenCalledTimes(1));
    const disconnecting = harness.lifecycle.disconnect();
    releaseRegistration();

    await connecting;
    await disconnecting;
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
    expect(harness.broker.stop).toHaveBeenCalledTimes(1);
  });

  it("continues run cleanup when settings synchronization fails", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.readSettings.mockRejectedValueOnce(new Error("settings unavailable"));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.tabs.reapInactiveRuns).toHaveBeenCalledTimes(1);
    expect(harness.onWarning).toHaveBeenCalledWith(
      "Rudder Browser settings sync failed.",
      expect.any(Error),
    );
  });
});
