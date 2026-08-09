import type { Db } from "@rudderhq/db";
import { createHostClientHandlers } from "@rudderhq/plugin-sdk";
import { logger } from "../middleware/logger.js";
import { setPluginEventBus } from "../services/activity-log.js";
import { createPluginDevWatcher } from "../services/plugin-dev-watcher.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";
import { buildHostServices, flushPluginLogBuffer } from "../services/plugin-host-services.js";
import { createPluginJobCoordinator } from "../services/plugin-job-coordinator.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { DEFAULT_LOCAL_PLUGIN_DIR, pluginLoader } from "../services/plugin-loader.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { RudderAppOptions } from "./types.js";

export function createPluginHostRuntime(db: Db, opts: RudderAppOptions) {
  const hostServicesDisposers = new Map<string, () => void>();
  const workerManager = createPluginWorkerManager();
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = createPluginEventBus();
  setPluginEventBus(eventBus);
  const jobStore = pluginJobStore(db);
  const lifecycle = pluginLifecycleManager(db, { workerManager });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  const toolDispatcher = createPluginToolDispatcher({
    workerManager,
    lifecycleManager: lifecycle,
    db,
  });
  const jobCoordinator = createPluginJobCoordinator({
    db,
    lifecycle,
    scheduler,
    jobStore,
  });
  const hostServiceCleanup = createPluginHostServiceCleanup(lifecycle, hostServicesDisposers);
  const loader = pluginLoader(
    db,
    { localPluginDir: opts.localPluginDir ?? DEFAULT_LOCAL_PLUGIN_DIR },
    {
      workerManager,
      eventBus,
      jobScheduler: scheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager: lifecycle,
      instanceInfo: {
        instanceId: opts.instanceId ?? "default",
        hostVersion: opts.hostVersion ?? "0.0.0",
      },
      buildHostHandlers: (pluginId, manifest) => {
        const notifyWorker = (method: string, params: unknown) => {
          const handle = workerManager.getWorker(pluginId);
          if (handle) handle.notify(method, params);
        };
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker, {
          allowedHttpOrigins: opts.pluginHttpAllowedOrigins,
        });
        hostServicesDisposers.set(pluginId, () => services.dispose());
        return createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        });
      },
    },
  );

  let devWatcher: ReturnType<typeof createPluginDevWatcher> | null = null;
  let started = false;
  let startupWork: Promise<void> | null = null;
  let closeInFlight: Promise<void> | null = null;

  const reportDisposeFailure = (name: string, error: unknown) => {
    logger.warn({ err: error, resource: name }, "Failed to close plugin host resource");
  };
  const disposeResource = async (
    name: string,
    dispose: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await dispose();
    } catch (error) {
      reportDisposeFailure(name, error);
    }
  };
  const disposeResourceSync = (name: string, dispose: () => void): void => {
    try {
      dispose();
    } catch (error) {
      reportDisposeFailure(name, error);
    }
  };

  const disposeHostRuntime = () => {
    void devWatcher?.close().catch((error) => reportDisposeFailure("plugin-dev-watcher", error));
    devWatcher = null;
    disposeResourceSync("plugin-job-coordinator", () => jobCoordinator.stop());
    disposeResourceSync("plugin-job-scheduler", () => scheduler.stop());
    disposeResourceSync("plugin-tool-dispatcher", () => toolDispatcher.teardown());
    disposeResourceSync("plugin-host-services", () => hostServiceCleanup.disposeAll());
    disposeResourceSync("plugin-host-service-listeners", () => hostServiceCleanup.teardown());
  };

  const onProcessExit = () => {
    disposeHostRuntime();
  };
  const onProcessBeforeExit = () => {
    void flushPluginLogBuffer();
  };
  const removeProcessListeners = () => {
    process.removeListener("exit", onProcessExit);
    process.removeListener("beforeExit", onProcessBeforeExit);
  };

  process.once("exit", onProcessExit);
  process.once("beforeExit", onProcessBeforeExit);

  return {
    loader,
    scheduler,
    jobStore,
    workerManager,
    toolDispatcher,
    async start() {
      if (closeInFlight) {
        throw new Error("Cannot start plugin host runtime after close has started");
      }
      if (started) return;
      started = true;

      try {
        jobCoordinator.start();
        scheduler.start();
        devWatcher = opts.uiMode === "vite-dev"
          ? createPluginDevWatcher(
            lifecycle,
            async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
          )
          : null;
      } catch (error) {
        started = false;
        throw error;
      }

      startupWork = Promise.resolve().then(async () => {
        const [dispatcherResult, loadResult] = await Promise.allSettled([
          toolDispatcher.initialize(),
          loader.loadAll(),
        ]);
        if (dispatcherResult.status === "rejected") {
          logger.error(
            { err: dispatcherResult.reason },
            "Failed to initialize plugin tool dispatcher",
          );
        }
        if (loadResult.status === "rejected") {
          logger.error({ err: loadResult.reason }, "Failed to load ready plugins on startup");
          return;
        }
        if (!loadResult.value) return;
        for (const loaded of loadResult.value.results) {
          if (devWatcher && loaded.success && loaded.plugin.packagePath) {
            devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
          }
        }
      }).catch((err) => {
        logger.error({ err }, "Failed to finish plugin host startup work");
      });
    },
    close() {
      if (closeInFlight) return closeInFlight;
      removeProcessListeners();
      closeInFlight = Promise.resolve().then(async () => {
        const watcher = devWatcher;
        devWatcher = null;
        await disposeResource("plugin-dev-watcher", () => watcher?.close() ?? Promise.resolve());
        await disposeResource("plugin-job-coordinator", () => jobCoordinator.stop());
        await disposeResource("plugin-job-scheduler", () => scheduler.stop());

        await disposeResource("plugin-startup-work", () => startupWork ?? Promise.resolve());

        await disposeResource("plugin-loader", () => loader.shutdownAll());
        await disposeResource("plugin-tool-dispatcher", () => toolDispatcher.teardown());
        await disposeResource("plugin-host-services", () => hostServiceCleanup.disposeAll());
        await disposeResource("plugin-host-service-listeners", () => hostServiceCleanup.teardown());
        await disposeResource("plugin-log-buffer", () => flushPluginLogBuffer());
      });
      return closeInFlight;
    },
  };
}

export type PluginHostRuntime = ReturnType<typeof createPluginHostRuntime>;
