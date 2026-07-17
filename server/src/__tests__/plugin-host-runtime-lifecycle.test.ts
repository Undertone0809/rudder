import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  coordinator: { start: vi.fn(), stop: vi.fn() },
  devWatcher: { close: vi.fn(), watch: vi.fn() },
  dispatcher: { initialize: vi.fn(), teardown: vi.fn() },
  eventBus: {},
  flushPluginLogBuffer: vi.fn(),
  hostServiceCleanup: { disposeAll: vi.fn(), teardown: vi.fn() },
  lifecycle: {},
  loader: { loadAll: vi.fn(), shutdownAll: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn() },
  pluginRegistry: { getById: vi.fn() },
  scheduler: { start: vi.fn(), stop: vi.fn() },
  workerManager: { getWorker: vi.fn() },
}));

vi.mock("@rudderhq/plugin-sdk", () => ({ createHostClientHandlers: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: mocks.logger }));
vi.mock("../services/activity-log.js", () => ({ setPluginEventBus: vi.fn() }));
vi.mock("../services/plugin-dev-watcher.js", () => ({
  createPluginDevWatcher: vi.fn(() => mocks.devWatcher),
}));
vi.mock("../services/plugin-event-bus.js", () => ({
  createPluginEventBus: vi.fn(() => mocks.eventBus),
}));
vi.mock("../services/plugin-host-service-cleanup.js", () => ({
  createPluginHostServiceCleanup: vi.fn(() => mocks.hostServiceCleanup),
}));
vi.mock("../services/plugin-host-services.js", () => ({
  buildHostServices: vi.fn(),
  flushPluginLogBuffer: mocks.flushPluginLogBuffer,
}));
vi.mock("../services/plugin-job-coordinator.js", () => ({
  createPluginJobCoordinator: vi.fn(() => mocks.coordinator),
}));
vi.mock("../services/plugin-job-scheduler.js", () => ({
  createPluginJobScheduler: vi.fn(() => mocks.scheduler),
}));
vi.mock("../services/plugin-job-store.js", () => ({ pluginJobStore: vi.fn(() => ({})) }));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: vi.fn(() => mocks.lifecycle),
}));
vi.mock("../services/plugin-loader.js", () => ({
  DEFAULT_LOCAL_PLUGIN_DIR: "/tmp/rudder-plugins",
  pluginLoader: vi.fn(() => mocks.loader),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: vi.fn(() => mocks.pluginRegistry),
}));
vi.mock("../services/plugin-tool-dispatcher.js", () => ({
  createPluginToolDispatcher: vi.fn(() => mocks.dispatcher),
}));
vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => mocks.workerManager),
}));

import { createPluginHostRuntime } from "../bootstrap/plugin-host-runtime.js";

const opts = {
  uiMode: "none",
  serverPort: 3100,
  storageService: {},
  deploymentMode: "local_trusted",
  deploymentExposure: "private",
  allowedHostnames: [],
  bindHost: "127.0.0.1",
  authReady: false,
  companyDeletionEnabled: false,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.devWatcher.close.mockResolvedValue(undefined);
  mocks.dispatcher.initialize.mockResolvedValue(undefined);
  mocks.loader.loadAll.mockResolvedValue({
    total: 0,
    succeeded: 0,
    failed: 0,
    results: [],
  });
  mocks.loader.shutdownAll.mockResolvedValue(undefined);
  mocks.flushPluginLogBuffer.mockResolvedValue(undefined);
  mocks.hostServiceCleanup.disposeAll.mockImplementation(() => undefined);
  mocks.hostServiceCleanup.teardown.mockImplementation(() => undefined);
});

describe("plugin host runtime lifecycle", () => {
  it("removes its named process listeners and tears down owned services on close", async () => {
    const exitListeners = process.listenerCount("exit");
    const beforeExitListeners = process.listenerCount("beforeExit");
    const runtime = createPluginHostRuntime({} as never, opts as never);

    expect(process.listenerCount("exit")).toBe(exitListeners + 1);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners + 1);

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;

    expect(process.listenerCount("exit")).toBe(exitListeners);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitListeners);
    expect(mocks.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(mocks.dispatcher.teardown).toHaveBeenCalledTimes(1);
    expect(mocks.hostServiceCleanup.teardown).toHaveBeenCalledTimes(1);
  });

  it("waits for tracked startup work before ordered shutdown", async () => {
    let finishLoading!: (value: { results: never[] }) => void;
    mocks.loader.loadAll.mockReturnValueOnce(new Promise((resolve) => {
      finishLoading = resolve;
    }));
    const runtime = createPluginHostRuntime({} as never, opts as never);
    await runtime.start();
    await vi.waitFor(() => expect(mocks.loader.loadAll).toHaveBeenCalledTimes(1));

    const closing = runtime.close();
    await vi.waitFor(() => expect(mocks.scheduler.stop).toHaveBeenCalledTimes(1));

    expect(mocks.loader.shutdownAll).not.toHaveBeenCalled();
    expect(mocks.dispatcher.teardown).not.toHaveBeenCalled();

    finishLoading({ results: [] });
    await closing;

    expect(mocks.loader.shutdownAll).toHaveBeenCalledTimes(1);
    expect(mocks.dispatcher.teardown).toHaveBeenCalledTimes(1);
    expect(mocks.scheduler.stop).toHaveBeenCalledTimes(1);
  });

  it("continues ordered teardown when early and late owned disposers throw", async () => {
    const watcherError = new Error("watcher close failed");
    const disposeError = new Error("host service dispose failed");
    mocks.devWatcher.close.mockRejectedValueOnce(watcherError);
    mocks.hostServiceCleanup.disposeAll.mockImplementationOnce(() => {
      throw disposeError;
    });
    const runtime = createPluginHostRuntime(
      {} as never,
      { ...opts, uiMode: "vite-dev" } as never,
    );
    await runtime.start();

    const firstClose = runtime.close();
    const duplicateClose = runtime.close();
    await expect(firstClose).resolves.toBeUndefined();

    expect(duplicateClose).toBe(firstClose);
    expect(mocks.devWatcher.close).toHaveBeenCalledTimes(1);
    expect(mocks.coordinator.stop).toHaveBeenCalledTimes(1);
    expect(mocks.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(mocks.loader.shutdownAll).toHaveBeenCalledTimes(1);
    expect(mocks.dispatcher.teardown).toHaveBeenCalledTimes(1);
    expect(mocks.hostServiceCleanup.disposeAll).toHaveBeenCalledTimes(1);
    expect(mocks.hostServiceCleanup.teardown).toHaveBeenCalledTimes(1);
    expect(mocks.flushPluginLogBuffer).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: watcherError, resource: "plugin-dev-watcher" },
      "Failed to close plugin host resource",
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: disposeError, resource: "plugin-host-services" },
      "Failed to close plugin host resource",
    );
  });
});
