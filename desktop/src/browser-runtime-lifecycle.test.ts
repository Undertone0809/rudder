import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopBrowserBrokerRegistrationError } from "./browser-broker-registration.js";
import { createDesktopBrowserRuntimeLifecycle } from "./browser-runtime-lifecycle.js";

const identity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };

function createHarness(options: {
  closeAllFails?: boolean;
  registrationFails?: boolean;
  registrationFailures?: number;
  unregisterFails?: boolean;
  registrationGate?: Promise<void>;
  registrationGates?: Array<Promise<void> | undefined>;
  initialServerEnabled?: boolean;
  reapGate?: Promise<void>;
} = {}) {
  const createBroker = (index: number) => ({
    endpoint: `http://127.0.0.1:${43123 + index}/browser`,
    token: `${String(index + 1).padStart(2, "0")}${"a".repeat(62)}`,
    stop: vi.fn(async () => undefined),
  });
  const broker = createBroker(0);
  const brokers = [broker];
  let brokerIndex = 0;
  let enabled = true;
  let remainingRegistrationFailures = options.registrationFailures ?? 0;
  let registrationCallCount = 0;
  const tabs = {
    execute: vi.fn(async () => ({ ok: true })),
    closeAll: options.closeAllFails
      ? vi.fn(async () => { throw new Error("tab cleanup failed"); })
      : vi.fn(async () => undefined),
    reapInactiveRuns: vi.fn(async (isRunActive: (value: typeof identity) => Promise<boolean>) => {
      await isRunActive(identity);
      await options.reapGate;
    }),
  };
  const registerBroker = vi.fn(async () => {
    const registrationGate = options.registrationGates?.[registrationCallCount] ?? options.registrationGate;
    registrationCallCount += 1;
    await registrationGate;
    if (options.registrationFails || remainingRegistrationFailures > 0) {
      remainingRegistrationFailures -= 1;
      throw new Error("registration failed");
    }
  });
  const unregisterBroker = options.unregisterFails
    ? vi.fn(async () => { throw new Error("unregister failed"); })
    : vi.fn(async () => undefined);
  let serverEnabled = options.initialServerEnabled ?? true;
  const readSettings = vi.fn(async () => ({ enabled: serverEnabled, openLinksIn: "built_in" as const }));
  const setProfileEnabled = vi.fn(async (value: boolean) => { enabled = value; });
  const isRunActive = vi.fn(async () => true);
  const onWarning = vi.fn();
  let brokerExecute: ((command: any) => Promise<unknown>) | null = null;
  const lifecycle = createDesktopBrowserRuntimeLifecycle({
    tabs,
    getProfileEnabled: () => enabled,
    setProfileEnabled,
    execute: tabs.execute,
    registerBroker,
    unregisterBroker,
    readSettings,
    isRunActive,
    sweepIntervalMs: 1_000,
    onWarning,
    startBroker: vi.fn(async (input) => {
      const nextBroker = brokers[brokerIndex] ?? createBroker(brokerIndex);
      if (!brokers[brokerIndex]) brokers.push(nextBroker);
      brokerIndex += 1;
      brokerExecute = input.execute;
      return nextBroker;
    }),
  });
  return {
    broker,
    brokers,
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
    setServerEnabled: (value: boolean) => { serverEnabled = value; },
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
    expect(harness.setProfileEnabled).not.toHaveBeenCalled();
    expect(harness.registerBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker,
      undefined,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.registerBroker).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker,
      undefined,
      true,
    );
    expect(harness.tabs.reapInactiveRuns).toHaveBeenCalledTimes(1);
    expect(harness.isRunActive).toHaveBeenCalledWith("http://127.0.0.1:3100/api", identity);
  });

  it("refreshes the active Broker registration so a restarted server can recover", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.registerBroker.mockClear();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.registerBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker,
      undefined,
      true,
    );
    expect(harness.broker.stop).not.toHaveBeenCalled();
    expect(harness.tabs.closeAll).toHaveBeenCalledTimes(1);
  });

  it("keeps the Broker offline while Browser is disabled and starts it after re-enable", async () => {
    const harness = createHarness({ initialServerEnabled: false });

    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    expect(harness.setProfileEnabled).toHaveBeenCalledWith(false);
    expect(harness.registerBroker).not.toHaveBeenCalled();

    harness.setServerEnabled(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.registerBroker).toHaveBeenCalledTimes(1));
  });

  it("unregisters and stops an active Broker when Browser becomes disabled", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    harness.setServerEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.broker.stop).toHaveBeenCalledTimes(1));
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
  });

  it("unregisters, stops, and closes leases before reconnecting or disconnecting", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    await harness.lifecycle.connect("http://127.0.0.1:3200/api");
    expect(harness.unregisterBroker).toHaveBeenCalledWith("http://127.0.0.1:3100/api", harness.broker.token);
    expect(harness.brokers[0].stop).toHaveBeenCalledTimes(1);
    expect(harness.tabs.closeAll).toHaveBeenCalledTimes(2);

    await harness.lifecycle.disconnect();
    expect(harness.unregisterBroker).toHaveBeenLastCalledWith("http://127.0.0.1:3200/api", harness.brokers[1].token);
    expect(harness.brokers[1].stop).toHaveBeenCalledTimes(1);
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

  it("retries a failed initial registration and restores Browser control", async () => {
    const harness = createHarness({ registrationFailures: 3 });

    await expect(harness.lifecycle.connect("http://127.0.0.1:3100/api"))
      .rejects.toThrow("registration failed");
    expect(harness.registerBroker).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(harness.registerBroker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.registerBroker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(harness.registerBroker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.registerBroker).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(harness.registerBroker).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.registerBroker).toHaveBeenCalledTimes(4));
    await expect(harness.executeBrokerCommand({
      identity,
      action: "tabs",
      args: {},
    })).resolves.toEqual({ ok: true });
  });

  it("stops and cancels a retry Broker when disconnect starts during registration", async () => {
    let releaseRetryRegistration!: () => void;
    const retryRegistrationGate = new Promise<void>((resolve) => { releaseRetryRegistration = resolve; });
    const harness = createHarness({
      registrationFailures: 1,
      registrationGates: [undefined, retryRegistrationGate],
    });

    await expect(harness.lifecycle.connect("http://127.0.0.1:3100/api"))
      .rejects.toThrow("registration failed");
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.registerBroker).toHaveBeenCalledTimes(2));

    const disconnecting = harness.lifecycle.disconnect();
    releaseRetryRegistration();
    await disconnecting;

    expect(harness.brokers[1].stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.registerBroker).toHaveBeenCalledTimes(2);
  });

  it("cancels an initial registration retry when disconnected", async () => {
    const harness = createHarness({ registrationFails: true });

    await expect(harness.lifecycle.connect("http://127.0.0.1:3100/api"))
      .rejects.toThrow("registration failed");
    await harness.lifecycle.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.registerBroker).toHaveBeenCalledTimes(1);
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

  it("does not carry a stale sweep reconcile into a later explicit connection", async () => {
    let releaseReap!: () => void;
    const reapGate = new Promise<void>((resolve) => { releaseReap = resolve; });
    const harness = createHarness({ reapGate });
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");

    harness.setServerEnabled(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.tabs.reapInactiveRuns).toHaveBeenCalledTimes(1));
    harness.setServerEnabled(true);
    const reconnecting = harness.lifecycle.connect("http://127.0.0.1:3200/api");
    releaseReap();
    await reconnecting;

    expect(harness.registerBroker).toHaveBeenCalledTimes(2);
    expect(harness.registerBroker).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:3200/api",
      harness.brokers[1],
      undefined,
    );
    expect(harness.brokers).toHaveLength(2);
  });

  it("continues run cleanup when registration refresh fails", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.registerBroker.mockRejectedValueOnce(new Error("refresh unavailable"));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.tabs.reapInactiveRuns).toHaveBeenCalledTimes(1);
    expect(harness.onWarning).toHaveBeenCalledWith(
      "Rudder Browser Broker registration refresh failed.",
      expect.any(Error),
    );
  });

  it("shuts down after a newer Desktop lifecycle rejects its refresh", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.registerBroker.mockRejectedValueOnce(new DesktopBrowserBrokerRegistrationError(409));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.broker.stop).toHaveBeenCalledTimes(1));

    await expect(harness.executeBrokerCommand({
      identity,
      action: "tabs",
      args: {},
    })).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(harness.unregisterBroker).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/api",
      harness.broker.token,
    );
    expect(harness.onWarning).not.toHaveBeenCalled();
  });

  it("reconciles a revoked refresh through disabled and re-enabled settings", async () => {
    const harness = createHarness();
    await harness.lifecycle.connect("http://127.0.0.1:3100/api");
    harness.readSettings
      .mockResolvedValueOnce({ enabled: true, openLinksIn: "built_in" })
      .mockResolvedValueOnce({ enabled: false, openLinksIn: "built_in" });
    harness.registerBroker.mockRejectedValueOnce(new DesktopBrowserBrokerRegistrationError(
      409,
      "browser_broker_revoked_registration",
    ));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.broker.stop).toHaveBeenCalledTimes(1));
    expect(harness.setProfileEnabled).toHaveBeenCalledWith(false);

    harness.setServerEnabled(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.registerBroker).toHaveBeenCalledTimes(3));
    await expect(harness.executeBrokerCommand({
      identity,
      action: "tabs",
      args: {},
    })).resolves.toEqual({ ok: true });
  });
});
