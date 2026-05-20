/**
 * PluginLoader — discovery, installation, and runtime activation of plugins.
 *
 * This service is the entry point for the plugin system's I/O boundary:
 *
 * 1. **Discovery** — Scans the local plugin directory
 *    (`~/.rudder/plugins/`) and `node_modules` for packages matching
 *    the `rudder-plugin-*` naming convention. Aggregates results with
 *    path-based deduplication.
 *
 * 2. **Installation** — `installPlugin()` downloads from npm (or reads a
 *    local path), validates the manifest, checks capability consistency,
 *    and persists the install record.
 *
 * 3. **Runtime activation** — `activatePlugin()` wires up a loaded plugin
 *    with all runtime services: resolves its entrypoint, builds
 *    capability-gated host handlers, spawns a worker process, syncs job
 *    declarations, registers event subscriptions, and discovers tools.
 *
 * 4. **Shutdown** — `shutdownAll()` gracefully stops all active workers
 *    and unregisters runtime hooks.
 *
 * @see PLUGIN_SPEC.md §8 — Plugin Discovery
 * @see PLUGIN_SPEC.md §10 — Package Contract
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Db } from "@rudderhq/db";
import type {
  PaperclipPluginManifestV1,
  PluginLauncherDeclaration,
  PluginRecord,
  PluginUiSlotDeclaration,
} from "@rudderhq/shared";
import { logger } from "../middleware/logger.js";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { PluginWorkerManager, WorkerStartOptions, WorkerToHostHandlers } from "./plugin-worker-manager.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";

export const execFileAsync = promisify(execFile);
export const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Naming convention for npm-published Rudder plugins.
 * Packages matching this pattern are considered Rudder plugins.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export const NPM_PLUGIN_PACKAGE_PREFIX = "rudder-plugin-";

/**
 * Default local plugin directory.  The loader scans this directory for
 * locally-installed plugin packages.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export const DEFAULT_LOCAL_PLUGIN_DIR = path.join(
  os.homedir(),
  ".rudder",
  "plugins",
);

export const DEV_TSX_LOADER_PATH = path.resolve(__dirname, "../../../cli/node_modules/tsx/dist/loader.mjs");

// ---------------------------------------------------------------------------
// Discovery result types
// ---------------------------------------------------------------------------

/**
 * A plugin package found during discovery from any source.
 */
export interface DiscoveredPlugin {
  /** Absolute path to the root of the npm package directory. */
  packagePath: string;
  /** The npm package name as declared in package.json. */
  packageName: string;
  /** Semver version from package.json. */
  version: string;
  /** Source that found this package. */
  source: PluginSource;
  /** The parsed and validated manifest if available, null if discovery-only. */
  manifest: PaperclipPluginManifestV1 | null;
}

/**
 * Sources from which plugins can be discovered.
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 */
export type PluginSource =
  | "local-filesystem"  // ~/.rudder/plugins/ local directory
  | "npm"               // npm packages matching rudder-plugin-* convention
  | "registry";         // future: remote plugin registry URL

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

/**
 * Result of a discovery scan.
 */
export interface PluginDiscoveryResult {
  /** Plugins successfully discovered and validated. */
  discovered: DiscoveredPlugin[];
  /** Packages found but with validation errors. */
  errors: Array<{ packagePath: string; packageName: string; error: string }>;
  /** Source(s) that were scanned. */
  sources: PluginSource[];
}

export function getDeclaredPageRoutePaths(manifest: PaperclipPluginManifestV1): string[] {
  return (manifest.ui?.slots ?? [])
    .filter((slot): slot is PluginUiSlotDeclaration => slot.type === "page" && typeof slot.routePath === "string" && slot.routePath.length > 0)
    .map((slot) => slot.routePath!);
}

// ---------------------------------------------------------------------------
// Loader options
// ---------------------------------------------------------------------------

/**
 * Options for the plugin loader service.
 */
export interface PluginLoaderOptions {
  /**
   * Path to the local plugin directory to scan.
   * Defaults to ~/.rudder/plugins/
   */
  localPluginDir?: string;

  /**
   * Whether to scan the local filesystem directory for plugins.
   * Defaults to true.
   */
  enableLocalFilesystem?: boolean;

  /**
   * Whether to discover installed npm packages matching the rudder-plugin-*
   * naming convention.
   * Defaults to true.
   */
  enableNpmDiscovery?: boolean;

  /**
   * Future: URL of the remote plugin registry to query.
   * When set, the loader will also fetch available plugins from this endpoint.
   * Registry support is not yet implemented; this field is reserved.
   */
  registryUrl?: string;
}

// ---------------------------------------------------------------------------
// Install options
// ---------------------------------------------------------------------------

/**
 * Options for installing a single plugin package.
 */
export interface PluginInstallOptions {
  /**
   * npm package name to install (e.g. "rudder-plugin-linear" or "@acme/plugin-linear").
   * Either packageName or localPath must be set.
   */
  packageName?: string;

  /**
   * Absolute or relative path to a local plugin directory for development installs.
   * When set, the plugin is loaded from this path without npm install.
   * Either packageName or localPath must be set.
   */
  localPath?: string;

  /**
   * Version specifier passed to npm install (e.g. "^1.2.0", "latest").
   * Ignored when localPath is set.
   */
  version?: string;

  /**
   * Plugin install directory where packages are managed.
   * Defaults to the localPluginDir configured on the service.
   */
  installDir?: string;
}

// ---------------------------------------------------------------------------
// Runtime options — services needed for initializing loaded plugins
// ---------------------------------------------------------------------------

/**
 * Runtime services passed to the loader for plugin initialization.
 *
 * When these are provided, the loader can fully activate plugins (spawn
 * workers, register event subscriptions, sync jobs, register tools).
 * When omitted, the loader operates in discovery/install-only mode.
 *
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export interface PluginRuntimeServices {
  /** Worker process manager for spawning and managing plugin workers. */
  workerManager: PluginWorkerManager;
  /** Event bus for registering plugin event subscriptions. */
  eventBus: PluginEventBus;
  /** Job scheduler for registering plugin cron jobs. */
  jobScheduler: PluginJobScheduler;
  /** Job store for syncing manifest job declarations to the DB. */
  jobStore: PluginJobStore;
  /** Tool dispatcher for registering plugin-contributed agent tools. */
  toolDispatcher: PluginToolDispatcher;
  /** Lifecycle manager for state transitions and worker lifecycle events. */
  lifecycleManager: PluginLifecycleManager;
  /**
   * Factory that creates worker-to-host RPC handlers for a given plugin.
   *
   * The returned handlers service worker→host calls (e.g. state.get,
   * events.emit, config.get). Each plugin gets its own set of handlers
   * scoped to its capabilities and plugin ID.
   */
  buildHostHandlers: (pluginId: string, manifest: PaperclipPluginManifestV1) => WorkerToHostHandlers;
  /**
   * Host instance information passed to the worker during initialization.
   * Includes the instance ID and host version.
   */
  instanceInfo: {
    instanceId: string;
    hostVersion: string;
  };
}

// ---------------------------------------------------------------------------
// Load results
// ---------------------------------------------------------------------------

/**
 * Result of activating (loading) a single plugin at runtime.
 *
 * Contains the plugin record, activation status, and any error that
 * occurred during the process.
 */
export interface PluginLoadResult {
  /** The plugin record from the database. */
  plugin: PluginRecord;
  /** Whether the plugin was successfully activated. */
  success: boolean;
  /** Error message if activation failed. */
  error?: string;
  /** Which subsystems were registered during activation. */
  registered: {
    /** True if the worker process was started. */
    worker: boolean;
    /** Number of event subscriptions registered (from manifest event declarations). */
    eventSubscriptions: number;
    /** Number of job declarations synced to the database. */
    jobs: number;
    /** Number of webhook endpoints declared in manifest. */
    webhooks: number;
    /** Number of agent tools registered. */
    tools: number;
  };
}

/**
 * Result of activating all ready plugins at server startup.
 */
export interface PluginLoadAllResult {
  /** Total number of plugins that were attempted. */
  total: number;
  /** Number of plugins successfully activated. */
  succeeded: number;
  /** Number of plugins that failed to activate. */
  failed: number;
  /** Per-plugin results. */
  results: PluginLoadResult[];
}

/**
 * Normalized UI contribution metadata extracted from a plugin manifest.
 *
 * The host serves all plugin UI bundles from the manifest's `entrypoints.ui`
 * directory and currently expects the bundle entry module to be `index.js`.
 */
export interface PluginUiContributionMetadata {
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface PluginLoader {
  /**
   * Discover all available plugins from configured sources.
   *
   * This performs a non-destructive scan of all enabled sources and returns
   * the discovered plugins with their parsed manifests.  No installs or DB
   * writes happen during discovery.
   *
   * @param npmSearchDirs - Optional override for node_modules directories to search.
   *   Passed through to discoverFromNpm. When omitted the defaults are used.
   *
   * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Scan the local filesystem plugin directory for installed plugin packages.
   *
   * Reads the plugin directory, attempts to load each subdirectory as an npm
   * package, and validates the plugin manifest.
   *
   * @param dir - Directory to scan (defaults to configured localPluginDir).
   */
  discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult>;

  /**
   * Discover Rudder plugins installed as npm packages in the current
   * Node.js environment matching the "rudder-plugin-*" naming convention.
   *
   * Looks for packages in node_modules that match the naming convention.
   *
   * @param searchDirs - node_modules directories to search (defaults to process cwd resolution).
   */
  discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult>;

  /**
   * Load and parse the plugin manifest from a package directory.
   *
   * Reads the package.json, finds the manifest entrypoint declared under
   * the "rudderPlugin.manifest" key, loads the manifest module, and
   * validates it against the plugin manifest schema.
   *
   * Returns null if the package is not a Rudder plugin.
   * Throws if the package is a Rudder plugin but the manifest is invalid.
   *
   * @see PLUGIN_SPEC.md §10 — Package Contract
   */
  loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null>;

  /**
   * Install a plugin package and register it in the database.
   *
   * Follows the install process described in PLUGIN_SPEC.md §8.3:
   * 1. Resolve npm package / local path.
   * 2. Install into the plugin directory (npm install).
   * 3. Read and validate plugin manifest.
   * 4. Reject incompatible plugin API versions.
   * 5. Validate manifest capabilities.
   * 6. Persist install record in Postgres.
   * 7. Return the discovered plugin for the caller to use.
   *
   * Worker spawning and lifecycle management are handled by the caller
   * (pluginLifecycleManager and the server startup orchestration).
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  installPlugin(options: PluginInstallOptions): Promise<DiscoveredPlugin>;

  /**
   * Upgrade an already-installed plugin to a newer version.
   *
   * Similar to installPlugin, but:
   * 1. Requires the plugin to already exist in the database.
   * 2. Uses the existing packageName if not provided in options.
   * 3. Updates the existing plugin record instead of creating a new one.
   * 4. Returns the old and new manifests for capability comparison.
   *
   * @see PLUGIN_SPEC.md §25.3 — Upgrade Lifecycle
   */
  upgradePlugin(pluginId: string, options: Omit<PluginInstallOptions, "installDir">): Promise<{
    oldManifest: PaperclipPluginManifestV1;
    newManifest: PaperclipPluginManifestV1;
    discovered: DiscoveredPlugin;
  }>;

  /**
   * Check whether a plugin API version is supported by this host.
   */
  isSupportedApiVersion(apiVersion: number): boolean;

  /**
   * Remove runtime-managed on-disk install artifacts for a plugin.
   *
   * This only cleans files under the managed local plugin directory. Local-path
   * source checkouts outside that directory are intentionally left alone.
   */
  cleanupInstallArtifacts(plugin: PluginRecord): Promise<void>;

  /**
   * Get the local plugin directory this loader is configured to use.
   */
  getLocalPluginDir(): string;

  // -----------------------------------------------------------------------
  // Runtime initialization (requires PluginRuntimeServices)
  // -----------------------------------------------------------------------

  /**
   * Load and activate all plugins that are in `ready` status.
   *
   * This is the main server-startup orchestration method. For each plugin
   * that is persisted as `ready`, it:
   * 1. Resolves the worker entrypoint from the manifest.
   * 2. Spawns the worker process via the worker manager.
   * 3. Syncs job declarations from the manifest to the `plugin_jobs` table.
   * 4. Registers the plugin with the job scheduler.
   * 5. Registers event subscriptions declared in the manifest (scoped via the event bus).
   * 6. Registers agent tools from the manifest via the tool dispatcher.
   *
   * Plugins that fail to activate are marked as `error` in the database.
   * Activation failures are non-fatal — other plugins continue loading.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   * Throws if runtime services are not available.
   *
   * @returns Aggregated results for all attempted plugin loads.
   *
   * @see PLUGIN_SPEC.md §8.4 — Server-Start Plugin Loading
   * @see PLUGIN_SPEC.md §12 — Process Model
   */
  loadAll(): Promise<PluginLoadAllResult>;

  /**
   * Activate a single plugin that is in `installed` or `ready` status.
   *
   * Used after a fresh install (POST /api/plugins/install) or after
   * enabling a previously disabled plugin. Performs the same subsystem
   * registration as `loadAll()` but for a single plugin.
   *
   * If the plugin is in `installed` status, transitions it to `ready`
   * via the lifecycle manager before spawning the worker.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to activate
   * @returns The activation result for this plugin
   *
   * @see PLUGIN_SPEC.md §8.3 — Install Process
   */
  loadSingle(pluginId: string): Promise<PluginLoadResult>;

  /**
   * Deactivate a single plugin — stop its worker and unregister all
   * subsystem registrations (events, jobs, tools).
   *
   * Used during plugin disable, uninstall, and before upgrade. Does NOT
   * change the plugin's status in the database — that is the caller's
   * responsibility (via the lifecycle manager).
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   *
   * @param pluginId - UUID of the plugin to deactivate
   * @param pluginKey - The plugin key (manifest ID) for scoped cleanup
   *
   * @see PLUGIN_SPEC.md §8.5 — Uninstall Process
   */
  unloadSingle(pluginId: string, pluginKey: string): Promise<void>;

  /**
   * Stop all managed plugin workers. Called during server shutdown.
   *
   * Stops the job scheduler and then stops all workers via the worker
   * manager. Does NOT change plugin statuses in the database — plugins
   * remain in `ready` so they are restarted on next boot.
   *
   * **Requires** `PluginRuntimeServices` to have been provided at construction.
   */
  shutdownAll(): Promise<void>;

  /**
   * Whether runtime services are available for plugin activation.
   */
  hasRuntimeServices(): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a package name matches the Rudder plugin naming convention.
 * Accepts both the "rudder-plugin-" prefix and scoped "@scope/plugin-" packages.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export function isPluginPackageName(name: string): boolean {
  if (name.startsWith(NPM_PLUGIN_PACKAGE_PREFIX)) return true;
  // Also accept scoped packages like @acme/plugin-linear or @rudderhq/plugin-*
  if (name.includes("/")) {
    const localPart = name.split("/")[1] ?? "";
    return localPart.startsWith("plugin-");
  }
  return false;
}

/**
 * Read and parse a package.json from a directory path.
 * Returns null if no package.json exists.
 */
export async function readPackageJson(
  dir: string,
): Promise<Record<string, unknown> | null> {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;

  try {
    const raw = await readFile(pkgPath, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Resolve the manifest entrypoint from a package.json and package root.
 *
 * The spec defines a "rudderPlugin" key in package.json with a "manifest"
 * subkey pointing to the manifest module.  This helper resolves the path.
 *
 * @see PLUGIN_SPEC.md §10 — Package Contract
 */
export function resolveManifestPath(
  packageRoot: string,
  pkgJson: Record<string, unknown>,
): string | null {
  const rudderPlugin = pkgJson["rudderPlugin"];
  if (
    rudderPlugin !== null &&
    typeof rudderPlugin === "object" &&
    !Array.isArray(rudderPlugin)
  ) {
    const manifestRelPath = (rudderPlugin as Record<string, unknown>)[
      "manifest"
    ];
    if (typeof manifestRelPath === "string") {
      // NOTE: the resolved path is returned as-is even if the file does not yet
      // exist on disk (e.g. the package has not been built).  Callers MUST guard
      // with existsSync() before passing the path to loadManifestFromPath().
      return path.resolve(packageRoot, manifestRelPath);
    }
  }

  // Fallback: look for dist/manifest.js as a convention
  const conventionalPath = path.join(packageRoot, "dist", "manifest.js");
  if (existsSync(conventionalPath)) {
    return conventionalPath;
  }

  // Fallback: look for manifest.js at package root
  const rootManifestPath = path.join(packageRoot, "manifest.js");
  if (existsSync(rootManifestPath)) {
    return rootManifestPath;
  }

  return null;
}

export function parseSemver(version: string): ParsedSemver | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function compareIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/.test(left);
  const rightIsNumeric = /^\d+$/.test(right);

  if (leftIsNumeric && rightIsNumeric) {
    return Number(left) - Number(right);
  }

  if (leftIsNumeric) return -1;
  if (rightIsNumeric) return 1;
  return left.localeCompare(right);
}

export function compareSemver(left: string, right: string): number {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (!leftParsed || !rightParsed) {
    throw new Error(`Invalid semver comparison: '${left}' vs '${right}'`);
  }

  const coreOrder = (
    ["major", "minor", "patch"] as const
  ).map((key) => leftParsed[key] - rightParsed[key]).find((delta) => delta !== 0);
  if (coreOrder) {
    return coreOrder;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }
  if (leftParsed.prerelease.length === 0) return 1;
  if (rightParsed.prerelease.length === 0) return -1;

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftId = leftParsed.prerelease[index];
    const rightId = rightParsed.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;

    const diff = compareIdentifiers(leftId, rightId);
    if (diff !== 0) return diff;
  }

  return 0;
}

export function getMinimumHostVersion(manifest: PaperclipPluginManifestV1): string | undefined {
  return manifest.minimumHostVersion ?? manifest.minimumPaperclipVersion;
}

/**
 * Extract UI contribution metadata from a manifest for route serialization.
 *
 * Returns `null` when the plugin does not declare any UI slots or launchers.
 * Launcher declarations are aggregated from both the legacy top-level
 * `launchers` field and the preferred `ui.launchers` field.
 */
export function getPluginUiContributionMetadata(
  manifest: PaperclipPluginManifestV1,
): PluginUiContributionMetadata | null {
  const slots = manifest.ui?.slots ?? [];
  const launchers = [
    ...(manifest.launchers ?? []),
    ...(manifest.ui?.launchers ?? []),
  ];

  if (slots.length === 0 && launchers.length === 0) {
    return null;
  }

  return {
    uiEntryFile: "index.js",
    slots,
    launchers,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PluginLoader service.
 *
 * The loader is responsible for plugin discovery, installation, and runtime
 * activation.  It reads plugin packages from the local filesystem and npm,
 * validates their manifests, registers them in the database, and — when
 * runtime services are provided — initialises worker processes, event
 * subscriptions, job schedules, webhook endpoints, and agent tools.
 *
 * Usage (discovery & install only):
 * ```ts
 * const loader = pluginLoader(db, { enableLocalFilesystem: true });
 *
 * // Discover all available plugins
 * const result = await loader.discoverAll();
 * for (const plugin of result.discovered) {
 *   console.log(plugin.packageName, plugin.manifest?.id);
 * }
 *
 * // Install a specific plugin
 * const discovered = await loader.installPlugin({
 *   packageName: "rudder-plugin-linear",
 *   version: "^1.0.0",
 * });
 * ```
 *
 * Usage (full runtime activation at server startup):
 * ```ts
 * const loader = pluginLoader(db, loaderOpts, {
 *   workerManager,
 *   eventBus,
 *   jobScheduler,
 *   jobStore,
 *   toolDispatcher,
 *   lifecycleManager,
 *   buildHostHandlers: (pluginId, manifest) => ({ ... }),
 *   instanceInfo: { instanceId: "inst-1", hostVersion: "1.0.0" },
 * });
 *
 * // Load all ready plugins at startup
 * const loadResult = await loader.loadAll();
 * console.log(`Loaded ${loadResult.succeeded}/${loadResult.total} plugins`);
 *
 * // Load a single plugin after install
 * const singleResult = await loader.loadSingle(pluginId);
 *
 * // Shutdown all plugin workers on server exit
 * await loader.shutdownAll();
 * ```
 *
 * @see PLUGIN_SPEC.md §8.1 — On-Disk Layout
 * @see PLUGIN_SPEC.md §8.3 — Install Process
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
