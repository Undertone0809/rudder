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
import { execFileAsync, __dirname, NPM_PLUGIN_PACKAGE_PREFIX, DEFAULT_LOCAL_PLUGIN_DIR, DEV_TSX_LOADER_PATH, DiscoveredPlugin, PluginSource, ParsedSemver, PluginDiscoveryResult, getDeclaredPageRoutePaths, PluginLoaderOptions, PluginInstallOptions, PluginRuntimeServices, PluginLoadResult, PluginLoadAllResult, PluginUiContributionMetadata, PluginLoader, isPluginPackageName, readPackageJson, resolveManifestPath, parseSemver, compareIdentifiers, compareSemver, getMinimumHostVersion, getPluginUiContributionMetadata } from "./plugin-loader.helpers.js";

export function resolveWorkerEntrypoint(
  plugin: PluginRecord & { packagePath?: string | null },
  localPluginDir: string,
): string {
  const manifest = plugin.manifestJson;
  const workerRelPath = manifest.entrypoints.worker;

  // For local-path installs we persist the resolved package path; use it first
  if (plugin.packagePath && existsSync(plugin.packagePath)) {
    const entrypoint = path.resolve(plugin.packagePath, workerRelPath);
    if (entrypoint.startsWith(path.resolve(plugin.packagePath)) && existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  // Try the local plugin directory (standard npm install location)
  const packageName = plugin.packageName;
  let packageDir: string;

  if (packageName.startsWith("@")) {
    // Scoped package: @scope/plugin-name → localPluginDir/node_modules/@scope/plugin-name
    const [scope, name] = packageName.split("/");
    packageDir = path.join(localPluginDir, "node_modules", scope!, name!);
  } else {
    packageDir = path.join(localPluginDir, "node_modules", packageName);
  }

  // Also check if the package exists directly under localPluginDir
  // (for direct local-path installs or symlinked packages)
  const directDir = path.join(localPluginDir, packageName);

  // Try in order: node_modules path, direct path
  for (const dir of [packageDir, directDir]) {
    const entrypoint = path.resolve(dir, workerRelPath);

    // Security: ensure entrypoint is actually inside the directory (prevent path traversal)
    if (!entrypoint.startsWith(path.resolve(dir))) {
      continue;
    }

    if (existsSync(entrypoint)) {
      return entrypoint;
    }
  }

  // Fallback: try the worker path as-is (absolute or relative to cwd)
  // ONLY if it's already an absolute path and we trust the manifest (which we've already validated)
  if (path.isAbsolute(workerRelPath) && existsSync(workerRelPath)) {
    return workerRelPath;
  }

  throw new Error(
    `Worker entrypoint not found for plugin "${plugin.pluginKey}". ` +
      `Checked: ${path.resolve(packageDir, workerRelPath)}, ` +
      `${path.resolve(directDir, workerRelPath)}`,
  );
}

export function resolveManagedInstallPackageDir(localPluginDir: string, packageName: string): string {
  if (packageName.startsWith("@")) {
    return path.join(localPluginDir, "node_modules", ...packageName.split("/"));
  }
  return path.join(localPluginDir, "node_modules", packageName);
}

export function isPathInsideDir(candidatePath: string, parentDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedParent = path.resolve(parentDir);
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

