import type { ComputerUseBrokerCommand, ComputerUseRuntimeIdentity } from "@rudderhq/shared";
import type { DesktopComputerReadiness, DesktopComputerSettings } from "./computer-broker-registration.js";

type BrokerHandle = { endpoint: string; token: string; stop(): Promise<void> };
type RuntimeHandle = {
  execute(command: ComputerUseBrokerCommand): Promise<unknown>;
  reapInactiveRuns(isRunActive: (identity: ComputerUseRuntimeIdentity) => Promise<boolean>): Promise<void>;
  shutdown(): Promise<void>;
};

export function createDesktopComputerRuntimeLifecycle(options: {
  runtime: RuntimeHandle;
  readSettings(apiUrl: string): Promise<DesktopComputerSettings>;
  readReadiness(): Promise<DesktopComputerReadiness>;
  isRunActive(apiUrl: string, identity: ComputerUseRuntimeIdentity): Promise<boolean>;
  startBroker(input: { execute(command: ComputerUseBrokerCommand): Promise<unknown> }): Promise<BrokerHandle>;
  allocateGeneration(): number;
  registerBroker(apiUrl: string, broker: BrokerHandle, generation: number, refresh?: boolean): Promise<void>;
  unregisterBroker(apiUrl: string, token: string): Promise<void>;
  pollIntervalMs?: number;
  onWarning?(message: string, error: unknown): void;
}) {
  let broker: BrokerHandle | null = null;
  let apiUrl: string | null = null;
  let generation: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let epoch = 0;
  let queue = Promise.resolve();
  let accepting = false;

  const warn = (message: string, error: unknown) => options.onWarning?.(message, error);
  const enqueue = <T>(operation: () => Promise<T>) => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const stopCurrent = async (clearPollTimer = true) => {
    accepting = false;
    if (clearPollTimer && timer) clearInterval(timer);
    if (clearPollTimer) timer = null;
    const currentBroker = broker;
    const currentApiUrl = apiUrl;
    broker = null;
    generation = null;
    if (currentBroker && currentApiUrl) {
      await options.unregisterBroker(currentApiUrl, currentBroker.token).catch((error) => warn("Computer Broker unregister failed.", error));
    }
    await currentBroker?.stop().catch((error) => warn("Computer Broker shutdown failed.", error));
    await options.runtime.shutdown().catch((error) => warn("Computer runtime shutdown failed.", error));
  };

  const reconcile = async (expectedEpoch: number) => {
    const currentApiUrl = apiUrl;
    if (!currentApiUrl || expectedEpoch !== epoch) return;
    const settings = await options.readSettings(currentApiUrl);
    if (expectedEpoch !== epoch) return;
    if (!settings.experimentalComputerUseEnabled) {
      if (broker) await stopCurrent(false);
      return;
    }
    const readiness = await options.readReadiness();
    if (expectedEpoch !== epoch) return;
    const shouldRun = readiness.actionReady;
    if (!shouldRun && broker) {
      await stopCurrent(false);
      return;
    }
    if (!shouldRun) return;
    if (broker && generation !== null) {
      try {
        await options.registerBroker(currentApiUrl, broker, generation, true);
      } catch (error) {
        warn("Computer Broker refresh failed.", error);
        await stopCurrent(false);
        return;
      }
      try {
        await options.runtime.reapInactiveRuns((identity) => options.isRunActive(currentApiUrl, identity));
      } catch (error) {
        warn("Computer Run cleanup failed.", error);
      }
      return;
    }
    const nextGeneration = options.allocateGeneration();
    const next = await options.startBroker({
      execute: async (command) => {
        if (!accepting || expectedEpoch !== epoch) throw new Error("Computer Broker is not accepting commands.");
        if (typeof command.deadlineAt === "number" && command.deadlineAt <= Date.now()) {
          throw new Error("Computer Use action expired before execution.");
        }
        return options.runtime.execute(command);
      },
    });
    if (expectedEpoch !== epoch || !apiUrl) {
      await next.stop();
      return;
    }
    try {
      await options.registerBroker(currentApiUrl, next, nextGeneration);
    } catch (error) {
      await next.stop().catch(() => undefined);
      throw error;
    }
    broker = next;
    generation = nextGeneration;
    accepting = true;
  };

  const connect = (nextApiUrl: string) => enqueue(async () => {
    epoch += 1;
    const expectedEpoch = epoch;
    await stopCurrent();
    apiUrl = nextApiUrl;
    await reconcile(expectedEpoch);
    const interval = options.pollIntervalMs ?? 5_000;
    timer = setInterval(() => {
      void enqueue(() => reconcile(expectedEpoch)).catch((error) => warn("Computer runtime reconciliation failed.", error));
    }, interval);
    timer.unref?.();
  });

  const refresh = () => enqueue(() => reconcile(epoch));

  const disconnect = () => enqueue(async () => {
    epoch += 1;
    apiUrl = null;
    await stopCurrent();
  });

  return { connect, refresh, disconnect };
}
