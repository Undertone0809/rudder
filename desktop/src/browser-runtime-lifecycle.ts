import { BrowserAgentError, type BrowserAgentCommand, type BrowserRuntimeIdentity } from "./browser-agent-tabs.js";
import {
  isDesktopBrowserBrokerRegistrationConflict,
  isDesktopBrowserBrokerRegistrationRevoked,
  type DesktopBrowserSettings,
} from "./browser-broker-registration.js";

type BrowserBrokerHandle = {
  endpoint: string;
  token: string;
  stop(): Promise<void>;
};

type BrowserTabController = {
  execute(command: BrowserAgentCommand): Promise<unknown>;
  closeAll(): Promise<void>;
  reapInactiveRuns(isRunActive: (identity: BrowserRuntimeIdentity) => Promise<boolean>): Promise<void>;
};

export function createDesktopBrowserRuntimeLifecycle(options: {
  tabs: BrowserTabController;
  getProfileEnabled(): boolean;
  setProfileEnabled(enabled: boolean): Promise<void>;
  execute(command: BrowserAgentCommand): Promise<unknown>;
  startBroker(input: { execute(command: BrowserAgentCommand): Promise<unknown> }): Promise<BrowserBrokerHandle>;
  allocateRegistrationGeneration?: () => number;
  registerBroker(
    apiUrl: string,
    broker: { endpoint: string; token: string },
    registrationGeneration?: number,
    refresh?: boolean,
  ): Promise<void>;
  unregisterBroker(apiUrl: string, token: string): Promise<void>;
  readSettings(apiUrl: string): Promise<DesktopBrowserSettings>;
  isRunActive(apiUrl: string, identity: BrowserRuntimeIdentity): Promise<boolean>;
  sweepIntervalMs?: number;
  onWarning?(message: string, error: unknown): void;
}) {
  let broker: BrowserBrokerHandle | null = null;
  let registeredApiUrl: string | null = null;
  let registeredGeneration: number | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let sweepInFlight: Promise<void> | null = null;
  let lifecycleQueue: Promise<void> = Promise.resolve();
  let lifecycleEpoch = 0;
  let acceptingCommands = false;
  let reconcileRequested = false;
  let supersededRequested = false;

  const warn = (message: string, error: unknown) => {
    options.onWarning?.(message, error);
  };

  const syncProfileSetting = async (apiUrl: string, expectedEpoch: number) => {
    const settings = await options.readSettings(apiUrl);
    if (expectedEpoch !== lifecycleEpoch) return null;
    if (settings.enabled !== options.getProfileEnabled()) {
      await options.setProfileEnabled(settings.enabled);
    }
    return settings;
  };

  const runSweep = (apiUrl: string, expectedEpoch: number): Promise<void> => {
    if (sweepInFlight) return sweepInFlight;
    sweepInFlight = (async () => {
      try {
        const settings = await syncProfileSetting(apiUrl, expectedEpoch);
        if (settings && Boolean(broker) !== settings.enabled) {
          acceptingCommands = false;
          reconcileRequested = true;
        } else if (settings?.enabled && broker) {
          try {
            await options.registerBroker(apiUrl, broker, registeredGeneration, true);
          } catch (error) {
            if (isDesktopBrowserBrokerRegistrationRevoked(error)) {
              acceptingCommands = false;
              reconcileRequested = true;
            } else if (isDesktopBrowserBrokerRegistrationConflict(error)) {
              acceptingCommands = false;
              supersededRequested = true;
            } else {
              warn("Rudder Browser Broker registration refresh failed.", error);
            }
          }
        }
      } catch (error) {
        warn("Rudder Browser settings sync failed.", error);
      }
      if (expectedEpoch !== lifecycleEpoch) return;
      try {
        await options.tabs.reapInactiveRuns(async (identity) => {
          const active = await options.isRunActive(apiUrl, identity);
          return expectedEpoch === lifecycleEpoch ? active : true;
        });
      } catch (error) {
        warn("Rudder Browser run cleanup failed.", error);
      }
    })().finally(() => {
      sweepInFlight = null;
      if (supersededRequested && expectedEpoch === lifecycleEpoch) {
        acceptingCommands = false;
        lifecycleEpoch += 1;
        void enqueue(disconnectCurrent);
        return;
      }
      if (reconcileRequested && expectedEpoch === lifecycleEpoch) {
        reconcileRequested = false;
        void connect(apiUrl);
      }
    });
    return sweepInFlight;
  };

  const disconnectCurrent = async () => {
    const currentBroker = broker;
    const currentApiUrl = registeredApiUrl;
    broker = null;
    registeredApiUrl = null;
    registeredGeneration = undefined;
    supersededRequested = false;
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    const brokerStop = currentBroker?.stop().catch((error) => {
      warn("Rudder Browser Broker shutdown failed.", error);
    });
    try {
      await options.tabs.closeAll();
    } catch (error) {
      warn("Rudder Browser tab cleanup failed.", error);
    }
    await sweepInFlight;
    if (currentBroker && currentApiUrl) {
      try {
        await options.unregisterBroker(currentApiUrl, currentBroker.token);
      } catch (error) {
        warn("Rudder Browser Broker unregister failed.", error);
      }
    }
    await brokerStop;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycleQueue.then(operation);
    lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const startSweepTimer = (apiUrl: string, expectedEpoch: number) => {
    const intervalMs = options.sweepIntervalMs ?? 15_000;
    sweepTimer = setInterval(() => {
      void runSweep(apiUrl, expectedEpoch);
    }, intervalMs);
    sweepTimer.unref?.();
  };

  const connect = (apiUrl: string): Promise<void> => {
    acceptingCommands = false;
    supersededRequested = false;
    const registrationGeneration = options.allocateRegistrationGeneration?.();
    const expectedEpoch = ++lifecycleEpoch;
    return enqueue(async () => {
    await disconnectCurrent();
    const settings = await syncProfileSetting(apiUrl, expectedEpoch);
    if (expectedEpoch !== lifecycleEpoch) return;
    registeredApiUrl = apiUrl;
    if (!settings?.enabled) {
      startSweepTimer(apiUrl, expectedEpoch);
      return;
    }
    const nextBroker = await options.startBroker({
      execute: async (command) => {
        if (!acceptingCommands || expectedEpoch !== lifecycleEpoch) {
          throw new BrowserAgentError("browser_unavailable", "Rudder Browser Broker is not accepting commands.");
        }
        return options.execute(command);
      },
    });
    if (expectedEpoch !== lifecycleEpoch) {
      registeredApiUrl = null;
      await nextBroker.stop().catch((error) => {
        warn("Rudder Browser stale Broker shutdown failed.", error);
      });
      return;
    }
    try {
      await options.registerBroker(apiUrl, nextBroker, registrationGeneration);
    } catch (error) {
      registeredApiUrl = null;
      await options.unregisterBroker(apiUrl, nextBroker.token).catch((unregisterError) => {
        warn("Rudder Browser Broker registration rollback failed.", unregisterError);
      });
      await nextBroker.stop().catch((stopError) => {
        warn("Rudder Browser Broker rollback failed.", stopError);
      });
      throw error;
    }
    if (expectedEpoch !== lifecycleEpoch) {
      await options.unregisterBroker(apiUrl, nextBroker.token).catch((error) => {
        warn("Rudder Browser stale Broker unregister failed.", error);
      });
      await nextBroker.stop().catch(() => undefined);
      return;
    }
    broker = nextBroker;
    registeredGeneration = registrationGeneration;
    acceptingCommands = true;
    startSweepTimer(apiUrl, expectedEpoch);
    });
  };

  const disconnect = (): Promise<void> => {
    acceptingCommands = false;
    lifecycleEpoch += 1;
    return enqueue(disconnectCurrent);
  };

  return { connect, disconnect };
}
