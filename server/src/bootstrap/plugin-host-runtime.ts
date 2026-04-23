import { createHostClientHandlers } from "@rudder/plugin-sdk";
import type { Db } from "@rudder/db";
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
        const services = buildHostServices(db, pluginId, manifest.id, eventBus, notifyWorker);
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

  const disposeHostRuntime = () => {
    devWatcher?.close();
    hostServiceCleanup.disposeAll();
    hostServiceCleanup.teardown();
  };

  process.once("exit", () => {
    disposeHostRuntime();
  });
  process.once("beforeExit", () => {
    void flushPluginLogBuffer();
  });

  return {
    loader,
    scheduler,
    jobStore,
    workerManager,
    toolDispatcher,
    async start() {
      jobCoordinator.start();
      scheduler.start();
      void toolDispatcher.initialize().catch((err) => {
        logger.error({ err }, "Failed to initialize plugin tool dispatcher");
      });
      devWatcher = opts.uiMode === "vite-dev"
        ? createPluginDevWatcher(
          lifecycle,
          async (pluginId) => (await pluginRegistry.getById(pluginId))?.packagePath ?? null,
        )
        : null;
      void loader.loadAll().then((result) => {
        if (!result) return;
        for (const loaded of result.results) {
          if (devWatcher && loaded.success && loaded.plugin.packagePath) {
            devWatcher.watch(loaded.plugin.id, loaded.plugin.packagePath);
          }
        }
      }).catch((err) => {
        logger.error({ err }, "Failed to load ready plugins on startup");
      });
    },
    async close() {
      devWatcher?.close();
      jobCoordinator.stop();
      try {
        await loader.shutdownAll();
      } catch (err) {
        logger.warn({ err }, "Failed to shutdown plugins cleanly");
      }
      hostServiceCleanup.disposeAll();
      hostServiceCleanup.teardown();
      await flushPluginLogBuffer();
    },
  };
}

export type PluginHostRuntime = ReturnType<typeof createPluginHostRuntime>;
