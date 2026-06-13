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
import type {
  PluginRecord
} from "@rudderhq/shared";
import { existsSync } from "node:fs";
import path from "node:path";
import { __dirname } from "./plugin-loader.helpers.js";

const SERVER_PACKAGE_ROOT = path.resolve(__dirname, "../..");

export interface PluginPackageResolutionOptions {
  serverPackageRoot?: string;
}

const BUNDLED_PLUGIN_PACKAGE_DIRS = new Map<string, string>([
  ["@rudderhq/plugin-linear", "plugin-linear"],
]);

export function resolvePluginPackageCandidateDirs(
  localPluginDir: string,
  packageName: string,
  packagePath?: string | null,
  options: PluginPackageResolutionOptions = {},
): string[] {
  const candidates: string[] = [];

  if (packagePath && existsSync(packagePath)) {
    candidates.push(path.resolve(packagePath));
  }

  if (packageName.startsWith("@")) {
    candidates.push(path.join(localPluginDir, "node_modules", ...packageName.split("/")));
  } else {
    candidates.push(path.join(localPluginDir, "node_modules", packageName));
  }

  candidates.push(path.join(localPluginDir, packageName));

  const bundledPluginDirName = BUNDLED_PLUGIN_PACKAGE_DIRS.get(packageName);
  if (bundledPluginDirName) {
    candidates.push(
      path.join(
        options.serverPackageRoot ?? SERVER_PACKAGE_ROOT,
        "dist",
        "bundled-plugins",
        bundledPluginDirName,
      ),
    );
  }

  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function resolveWorkerEntrypoint(
  plugin: PluginRecord & { packagePath?: string | null },
  localPluginDir: string,
  options: PluginPackageResolutionOptions = {},
): string {
  const manifest = plugin.manifestJson;
  const workerRelPath = manifest.entrypoints.worker;
  const packageName = plugin.packageName;
  const checkedEntrypoints: string[] = [];

  for (const dir of resolvePluginPackageCandidateDirs(
    localPluginDir,
    packageName,
    plugin.packagePath,
    options,
  )) {
    const entrypoint = path.resolve(dir, workerRelPath);
    checkedEntrypoints.push(entrypoint);

    // Security: ensure entrypoint is actually inside the directory (prevent path traversal)
    if (!isPathInsideDir(entrypoint, dir)) {
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
      `Checked: ${checkedEntrypoints.join(", ")}`,
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
