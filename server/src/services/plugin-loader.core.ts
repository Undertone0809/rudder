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
 * @see doc/engineering/PLUGIN_RUNTIME_CONTRACT.md — Plugin Discovery
 * @see doc/engineering/PLUGIN_RUNTIME_CONTRACT.md — Package Contract
 * @see doc/engineering/PLUGIN_RUNTIME_CONTRACT.md — Process Model
 */
import type { Db } from "@rudderhq/db";
import type {
  PaperclipPluginManifestV1,
  PluginRecord
} from "@rudderhq/shared";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";
import { compareSemver, DEFAULT_LOCAL_PLUGIN_DIR, DEV_TSX_LOADER_PATH, DiscoveredPlugin, execFileAsync, getDeclaredPageRoutePaths, getMinimumHostVersion, isPluginPackageName, PluginDiscoveryResult, PluginInstallOptions, PluginLoadAllResult, PluginLoader, PluginLoaderOptions, PluginLoadResult, PluginRuntimeServices, PluginSource, readPackageJson, resolveManifestPath } from "./plugin-loader.helpers.js";
import { isPathInsideDir, resolveManagedInstallPackageDir, resolveWorkerEntrypoint } from "./plugin-loader.worker-paths.js";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { WorkerStartOptions } from "./plugin-worker-manager.js";

export function pluginLoader(
  db: Db,
  options: PluginLoaderOptions = {},
  runtimeServices?: PluginRuntimeServices,
): PluginLoader {
  const {
    localPluginDir = DEFAULT_LOCAL_PLUGIN_DIR,
    enableLocalFilesystem = true,
    enableNpmDiscovery = true,
  } = options;

  const registry = pluginRegistryService(db);
  const manifestValidator = pluginManifestValidator();
  const capabilityValidator = pluginCapabilityValidator();
  const log = logger.child({ service: "plugin-loader" });
  const hostVersion = runtimeServices?.instanceInfo.hostVersion;

  async function assertPageRoutePathsAvailable(manifest: PaperclipPluginManifestV1): Promise<void> {
    const requestedRoutePaths = getDeclaredPageRoutePaths(manifest);
    if (requestedRoutePaths.length === 0) return;

    const uniqueRequested = new Set(requestedRoutePaths);
    if (uniqueRequested.size !== requestedRoutePaths.length) {
      throw new Error(`Plugin ${manifest.id} declares duplicate page routePath values`);
    }

    const installedPlugins = await registry.listInstalled();
    for (const plugin of installedPlugins) {
      if (plugin.pluginKey === manifest.id) continue;
      const installedManifest = plugin.manifestJson as PaperclipPluginManifestV1 | null;
      if (!installedManifest) continue;
      const installedRoutePaths = new Set(getDeclaredPageRoutePaths(installedManifest));
      const conflictingRoute = requestedRoutePaths.find((routePath) => installedRoutePaths.has(routePath));
      if (conflictingRoute) {
        throw new Error(
          `Plugin ${manifest.id} routePath "${conflictingRoute}" conflicts with installed plugin ${plugin.pluginKey}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch a plugin from npm or local path, then parse and validate its manifest.
   *
   * This internal helper encapsulates the core plugin retrieval and validation
   * logic used by both install and upgrade operations. It handles:
   * 1. Resolving the package from npm or local filesystem.
   * 2. Installing the package via npm if necessary.
   * 3. Reading and parsing the plugin manifest.
   * 4. Validating API version compatibility.
   * 5. Validating manifest capabilities.
   *
   * @param installOptions - Options specifying the package to fetch.
   * @returns A `DiscoveredPlugin` object containing the validated manifest.
   */
  async function fetchAndValidate(
    installOptions: PluginInstallOptions,
  ): Promise<DiscoveredPlugin> {
    const { packageName, localPath, version, installDir } = installOptions;

    if (!packageName && !localPath) {
      throw new Error("Either packageName or localPath must be provided");
    }

    const targetInstallDir = installDir ?? localPluginDir;

    // Step 1 & 2: Resolve and install package
    let resolvedPackagePath: string;
    let resolvedPackageName: string;

    if (localPath) {
      // Local path install — validate the directory exists
      const absLocalPath = path.resolve(localPath);
      if (!existsSync(absLocalPath)) {
        throw new Error(`Local plugin path does not exist: ${absLocalPath}`);
      }
      resolvedPackagePath = absLocalPath;
      const pkgJson = await readPackageJson(absLocalPath);
      resolvedPackageName =
        typeof pkgJson?.["name"] === "string"
          ? pkgJson["name"]
          : path.basename(absLocalPath);

      log.info(
        { localPath: absLocalPath, packageName: resolvedPackageName },
        "plugin-loader: fetching plugin from local path",
      );
    } else {
      // npm install
      const spec = version ? `${packageName}@${version}` : packageName!;

      log.info(
        { spec, installDir: targetInstallDir },
        "plugin-loader: fetching plugin from npm",
      );

      try {
        // Use execFile (not exec) to avoid shell injection from package name/version.
        // --ignore-scripts prevents preinstall/install/postinstall hooks from
        // executing arbitrary code on the host before manifest validation.
        await execFileAsync(
          "npm",
          ["install", spec, "--prefix", targetInstallDir, "--save", "--ignore-scripts"],
          { timeout: 120_000 }, // 2 minute timeout for npm install
        );
      } catch (err) {
        throw new Error(`npm install failed for ${spec}: ${String(err)}`);
      }

      // Resolve the package path after installation
      const nodeModulesPath = path.join(targetInstallDir, "node_modules");
      resolvedPackageName = packageName!;

      // Handle scoped packages
      if (resolvedPackageName.startsWith("@")) {
        const [scope, name] = resolvedPackageName.split("/");
        resolvedPackagePath = path.join(nodeModulesPath, scope!, name!);
      } else {
        resolvedPackagePath = path.join(nodeModulesPath, resolvedPackageName);
      }

      if (!existsSync(resolvedPackagePath)) {
        throw new Error(
          `Package directory not found after installation: ${resolvedPackagePath}`,
        );
      }
    }

    // Step 3: Read and validate plugin manifest
    // Note: this.loadManifest (used via current context)
    const pkgJson = await readPackageJson(resolvedPackagePath);
    if (!pkgJson) throw new Error(`Missing package.json at ${resolvedPackagePath}`);

    const manifestPath = resolveManifestPath(resolvedPackagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      throw new Error(
        `Package ${resolvedPackageName} at ${resolvedPackagePath} does not appear to be a Rudder plugin (no manifest found).`,
      );
    }

    const manifest = await loadManifestFromPath(manifestPath);

    // Step 4: Reject incompatible plugin API versions
    if (!manifestValidator.getSupportedVersions().includes(manifest.apiVersion)) {
      throw new Error(
        `Plugin ${manifest.id} declares apiVersion ${manifest.apiVersion} which is not supported by this host. ` +
          `Supported versions: ${manifestValidator.getSupportedVersions().join(", ")}`,
      );
    }

    // Step 5: Validate manifest capabilities are consistent
    const capResult = capabilityValidator.validateManifestCapabilities(manifest);
    if (!capResult.allowed) {
      throw new Error(
        `Plugin ${manifest.id} manifest has inconsistent capabilities. ` +
          `Missing required capabilities for declared features: ${capResult.missing.join(", ")}`,
      );
    }

    await assertPageRoutePathsAvailable(manifest);

    // Step 6: Reject plugins that require a newer host than the running server
    const minimumHostVersion = getMinimumHostVersion(manifest);
    if (minimumHostVersion && hostVersion) {
      if (compareSemver(hostVersion, minimumHostVersion) < 0) {
        throw new Error(
          `Plugin ${manifest.id} requires host version ${minimumHostVersion} or newer, ` +
            `but this server is running ${hostVersion}`,
        );
      }
    }

    // Use the version declared in the manifest.
    const resolvedVersion = manifest.version;

    return {
      packagePath: resolvedPackagePath,
      packageName: resolvedPackageName,
      version: resolvedVersion,
      source: localPath ? "local-filesystem" : "npm",
      manifest,
    };
  }

  /**
   * Attempt to load and validate a plugin manifest from a resolved path.
   * Returns the manifest on success or throws with a descriptive error.
   */
  async function loadManifestFromPath(
    manifestPath: string,
  ): Promise<PaperclipPluginManifestV1> {
    let raw: unknown;

    try {
      // Dynamic import works for both .js (ESM) and .cjs (CJS) manifests
      const mod = await import(manifestPath) as Record<string, unknown>;
      // The manifest may be the default export or the module itself
      raw = mod["default"] ?? mod;
    } catch (err) {
      throw new Error(
        `Failed to load manifest module at ${manifestPath}: ${String(err)}`,
      );
    }

    return manifestValidator.parseOrThrow(raw);
  }

  /**
   * Build a DiscoveredPlugin from a resolved package directory, or null
   * if the package is not a Rudder plugin.
   */
  async function buildDiscoveredPlugin(
    packagePath: string,
    source: PluginSource,
  ): Promise<DiscoveredPlugin | null> {
    const pkgJson = await readPackageJson(packagePath);
    if (!pkgJson) return null;

    const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
    const version = typeof pkgJson["version"] === "string" ? pkgJson["version"] : "0.0.0";

    // Determine if this is a plugin package at all
    const hasPaperclipPlugin = "rudderPlugin" in pkgJson;
    const nameMatchesConvention = isPluginPackageName(packageName);

    if (!hasPaperclipPlugin && !nameMatchesConvention) {
      return null;
    }

    const manifestPath = resolveManifestPath(packagePath, pkgJson);
    if (!manifestPath || !existsSync(manifestPath)) {
      // Found a potential plugin package but no manifest entry point — treat
      // as a discovery-only result with no manifest
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest: null,
      };
    }

    try {
      const manifest = await loadManifestFromPath(manifestPath);
      return {
        packagePath,
        packageName,
        version,
        source,
        manifest,
      };
    } catch (err) {
      // Rethrow with context — callers catch and route to the errors array
      throw new Error(
        `Plugin ${packageName}: ${String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    // -----------------------------------------------------------------------
    // discoverAll
    // -----------------------------------------------------------------------

    async discoverAll(npmSearchDirs?: string[]): Promise<PluginDiscoveryResult> {
      const allDiscovered: DiscoveredPlugin[] = [];
      const allErrors: Array<{ packagePath: string; packageName: string; error: string }> = [];
      const sources: PluginSource[] = [];

      if (enableLocalFilesystem) {
        sources.push("local-filesystem");
        const fsResult = await this.discoverFromLocalFilesystem();
        allDiscovered.push(...fsResult.discovered);
        allErrors.push(...fsResult.errors);
      }

      if (enableNpmDiscovery) {
        sources.push("npm");
        const npmResult = await this.discoverFromNpm(npmSearchDirs);
        // Deduplicate against already-discovered packages (same package path)
        const existingPaths = new Set(allDiscovered.map((d) => d.packagePath));
        for (const plugin of npmResult.discovered) {
          if (!existingPaths.has(plugin.packagePath)) {
            allDiscovered.push(plugin);
          }
        }
        allErrors.push(...npmResult.errors);
      }

      // Future: registry source (options.registryUrl)
      if (options.registryUrl) {
        sources.push("registry");
        log.warn(
          { registryUrl: options.registryUrl },
          "plugin-loader: remote registry discovery is not yet implemented",
        );
      }

      log.info(
        {
          discovered: allDiscovered.length,
          errors: allErrors.length,
          sources,
        },
        "plugin-loader: discovery complete",
      );

      return { discovered: allDiscovered, errors: allErrors, sources };
    },

    // -----------------------------------------------------------------------
    // discoverFromLocalFilesystem
    // -----------------------------------------------------------------------

    async discoverFromLocalFilesystem(dir?: string): Promise<PluginDiscoveryResult> {
      const scanDir = dir ?? localPluginDir;
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      if (!existsSync(scanDir)) {
        log.debug(
          { dir: scanDir },
          "plugin-loader: local plugin directory does not exist, skipping",
        );
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      let entries: string[];
      try {
        entries = await readdir(scanDir);
      } catch (err) {
        log.warn({ dir: scanDir, err }, "plugin-loader: failed to read local plugin directory");
        return { discovered, errors, sources: ["local-filesystem"] };
      }

      for (const entry of entries) {
        const entryPath = path.join(scanDir, entry);

        // Check if entry is a directory
        let entryStat;
        try {
          entryStat = await stat(entryPath);
        } catch {
          continue;
        }
        if (!entryStat.isDirectory()) continue;

        // Handle scoped packages: @scope/plugin-name is a subdirectory
        if (entry.startsWith("@")) {
          let scopedEntries: string[];
          try {
            scopedEntries = await readdir(entryPath);
          } catch {
            continue;
          }
          for (const scopedEntry of scopedEntries) {
            const scopedPath = path.join(entryPath, scopedEntry);
            try {
              const scopedStat = await stat(scopedPath);
              if (!scopedStat.isDirectory()) continue;
              const plugin = await buildDiscoveredPlugin(scopedPath, "local-filesystem");
              if (plugin) discovered.push(plugin);
            } catch (err) {
              errors.push({
                packagePath: scopedPath,
                packageName: `${entry}/${scopedEntry}`,
                error: String(err),
              });
            }
          }
          continue;
        }

        try {
          const plugin = await buildDiscoveredPlugin(entryPath, "local-filesystem");
          if (plugin) discovered.push(plugin);
        } catch (err) {
          const pkgJson = await readPackageJson(entryPath);
          const packageName =
            typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
          errors.push({ packagePath: entryPath, packageName, error: String(err) });
        }
      }

      log.debug(
        { dir: scanDir, discovered: discovered.length, errors: errors.length },
        "plugin-loader: local filesystem scan complete",
      );

      return { discovered, errors, sources: ["local-filesystem"] };
    },

    // -----------------------------------------------------------------------
    // discoverFromNpm
    // -----------------------------------------------------------------------

    async discoverFromNpm(searchDirs?: string[]): Promise<PluginDiscoveryResult> {
      const discovered: DiscoveredPlugin[] = [];
      const errors: Array<{ packagePath: string; packageName: string; error: string }> = [];

      // Determine the node_modules directories to search.
      // When searchDirs is undefined OR empty, fall back to the conventional
      // defaults (cwd/node_modules and localPluginDir/node_modules).
      // To search nowhere explicitly, pass a non-empty array of non-existent paths.
      const dirsToSearch: string[] = searchDirs && searchDirs.length > 0 ? searchDirs : [];

      if (dirsToSearch.length === 0) {
        // Default: search node_modules relative to the process working directory
        // and also the local plugin dir's node_modules
        const cwdNodeModules = path.join(process.cwd(), "node_modules");
        const localNodeModules = path.join(localPluginDir, "node_modules");

        if (existsSync(cwdNodeModules)) dirsToSearch.push(cwdNodeModules);
        if (existsSync(localNodeModules)) dirsToSearch.push(localNodeModules);
      }

      for (const nodeModulesDir of dirsToSearch) {
        if (!existsSync(nodeModulesDir)) continue;

        let entries: string[];
        try {
          entries = await readdir(nodeModulesDir);
        } catch {
          continue;
        }

        for (const entry of entries) {
          const entryPath = path.join(nodeModulesDir, entry);

          // Handle scoped packages (@scope/*)
          if (entry.startsWith("@")) {
            let scopedEntries: string[];
            try {
              scopedEntries = await readdir(entryPath);
            } catch {
              continue;
            }
            for (const scopedEntry of scopedEntries) {
              const fullName = `${entry}/${scopedEntry}`;
              if (!isPluginPackageName(fullName)) continue;

              const scopedPath = path.join(entryPath, scopedEntry);
              try {
                const plugin = await buildDiscoveredPlugin(scopedPath, "npm");
                if (plugin) discovered.push(plugin);
              } catch (err) {
                errors.push({
                  packagePath: scopedPath,
                  packageName: fullName,
                  error: String(err),
                });
              }
            }
            continue;
          }

          // Non-scoped packages: check naming convention
          if (!isPluginPackageName(entry)) continue;

          let entryStat;
          try {
            entryStat = await stat(entryPath);
          } catch {
            continue;
          }
          if (!entryStat.isDirectory()) continue;

          try {
            const plugin = await buildDiscoveredPlugin(entryPath, "npm");
            if (plugin) discovered.push(plugin);
          } catch (err) {
            const pkgJson = await readPackageJson(entryPath);
            const packageName =
              typeof pkgJson?.["name"] === "string" ? pkgJson["name"] : entry;
            errors.push({ packagePath: entryPath, packageName, error: String(err) });
          }
        }
      }

      log.debug(
        { searchDirs: dirsToSearch, discovered: discovered.length, errors: errors.length },
        "plugin-loader: npm discovery scan complete",
      );

      return { discovered, errors, sources: ["npm"] };
    },

    // -----------------------------------------------------------------------
    // loadManifest
    // -----------------------------------------------------------------------

    async loadManifest(packagePath: string): Promise<PaperclipPluginManifestV1 | null> {
      const pkgJson = await readPackageJson(packagePath);
      if (!pkgJson) return null;

      const hasPaperclipPlugin = "rudderPlugin" in pkgJson;
      const packageName = typeof pkgJson["name"] === "string" ? pkgJson["name"] : "";
      const nameMatchesConvention = isPluginPackageName(packageName);

      if (!hasPaperclipPlugin && !nameMatchesConvention) {
        return null;
      }

      const manifestPath = resolveManifestPath(packagePath, pkgJson);
      if (!manifestPath || !existsSync(manifestPath)) return null;

      return loadManifestFromPath(manifestPath);
    },

    // -----------------------------------------------------------------------
    // installPlugin
    // -----------------------------------------------------------------------

    async installPlugin(installOptions: PluginInstallOptions): Promise<DiscoveredPlugin> {
      const discovered = await fetchAndValidate(installOptions);

      // Step 6: Persist install record in Postgres (include packagePath for local installs so the worker can be resolved)
      await registry.install(
        {
          packageName: discovered.packageName,
          packagePath: discovered.source === "local-filesystem" ? discovered.packagePath : undefined,
        },
        discovered.manifest!,
      );

      log.info(
        {
          pluginId: discovered.manifest!.id,
          packageName: discovered.packageName,
          version: discovered.version,
          capabilities: discovered.manifest!.capabilities,
        },
        "plugin-loader: plugin installed successfully",
      );

      return discovered;
    },

    // -----------------------------------------------------------------------
    // upgradePlugin
    // -----------------------------------------------------------------------

    /**
     * Upgrade an already-installed plugin to a newer version.
     *
     * This method:
     * 1. Fetches and validates the new plugin package using `fetchAndValidate`.
     * 2. Ensures the new manifest ID matches the existing plugin ID for safety.
     * 3. Updates the plugin record in the registry with the new version and manifest.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param upgradeOptions - Options for the upgrade (packageName, localPath, version).
     * @returns The old and new manifests, along with the discovery metadata.
     * @throws {Error} If the plugin is not found or if the new manifest ID differs.
     */
    async upgradePlugin(
      pluginId: string,
      upgradeOptions: Omit<PluginInstallOptions, "installDir">,
    ): Promise<{
      oldManifest: PaperclipPluginManifestV1;
      newManifest: PaperclipPluginManifestV1;
      discovered: DiscoveredPlugin;
    }> {
      const plugin = (await registry.getById(pluginId)) as {
        id: string;
        packageName: string;
        packagePath: string | null;
        manifestJson: PaperclipPluginManifestV1;
      } | null;
      if (!plugin) throw new Error(`Plugin not found: ${pluginId}`);

      const oldManifest = plugin.manifestJson;
      const {
        packageName = plugin.packageName,
        // For local-path installs, fall back to the stored packagePath so
        // `upgradePlugin` can re-read the manifest from disk without needing
        // the caller to re-supply the path every time.
        localPath = plugin.packagePath ?? undefined,
        version,
      } = upgradeOptions;

      log.info(
        { pluginId, packageName, version, localPath },
        "plugin-loader: upgrading plugin",
      );

      // 1. Fetch/Install the new version
      const discovered = await fetchAndValidate({
        packageName,
        localPath,
        version,
        installDir: localPluginDir,
      });

      const newManifest = discovered.manifest!;

      // 2. Validate it's the same plugin ID
      if (newManifest.id !== oldManifest.id) {
        throw new Error(
          `Upgrade failed: new manifest ID '${newManifest.id}' does not match existing plugin ID '${oldManifest.id}'`,
        );
      }

      // 3. Detect capability escalation — new capabilities not in the old manifest
      const oldCaps = new Set(oldManifest.capabilities ?? []);
      const newCaps = newManifest.capabilities ?? [];
      const escalated = newCaps.filter((c) => !oldCaps.has(c));

      if (escalated.length > 0) {
        log.warn(
          { pluginId, escalated, oldVersion: oldManifest.version, newVersion: newManifest.version },
          "plugin-loader: upgrade introduces new capabilities — requires admin approval",
        );
        throw new Error(
          `Upgrade for "${pluginId}" introduces new capabilities that require approval: ${escalated.join(", ")}. ` +
            `The previous version declared [${[...oldCaps].join(", ")}]. ` +
            `Please review and approve the capability escalation before upgrading.`,
        );
      }

      // 4. Update the existing record
      await registry.update(pluginId, {
        packageName: discovered.packageName,
        version: discovered.version,
        manifest: newManifest,
      });

      return {
        oldManifest,
        newManifest,
        discovered,
      };
    },

    // -----------------------------------------------------------------------
    // isSupportedApiVersion
    // -----------------------------------------------------------------------

    isSupportedApiVersion(apiVersion: number): boolean {
      return manifestValidator.getSupportedVersions().includes(apiVersion);
    },

    // -----------------------------------------------------------------------
    // cleanupInstallArtifacts
    // -----------------------------------------------------------------------

    async cleanupInstallArtifacts(plugin: PluginRecord): Promise<void> {
      const managedTargets = new Set<string>();
      const managedNodeModulesDir = resolveManagedInstallPackageDir(localPluginDir, plugin.packageName);
      const directManagedDir = path.join(localPluginDir, plugin.packageName);

      managedTargets.add(managedNodeModulesDir);
      if (isPathInsideDir(directManagedDir, localPluginDir)) {
        managedTargets.add(directManagedDir);
      }
      if (plugin.packagePath && isPathInsideDir(plugin.packagePath, localPluginDir)) {
        managedTargets.add(path.resolve(plugin.packagePath));
      }

      const packageJsonPath = path.join(localPluginDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          await execFileAsync(
            "npm",
            ["uninstall", plugin.packageName, "--prefix", localPluginDir, "--ignore-scripts"],
            { timeout: 120_000 },
          );
        } catch (err) {
          log.warn(
            {
              pluginId: plugin.id,
              pluginKey: plugin.pluginKey,
              packageName: plugin.packageName,
              err: err instanceof Error ? err.message : String(err),
            },
            "plugin-loader: npm uninstall failed during cleanup, falling back to direct removal",
          );
        }
      }

      for (const target of managedTargets) {
        if (!existsSync(target)) continue;
        await rm(target, { recursive: true, force: true });
      }
    },

    // -----------------------------------------------------------------------
    // getLocalPluginDir
    // -----------------------------------------------------------------------

    getLocalPluginDir(): string {
      return localPluginDir;
    },

    // -----------------------------------------------------------------------
    // hasRuntimeServices
    // -----------------------------------------------------------------------

    hasRuntimeServices(): boolean {
      return runtimeServices !== undefined;
    },

    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // loadAll
    // -----------------------------------------------------------------------

    /**
     * loadAll — Loads and activates all plugins that are currently in 'ready' status.
     *
     * This method is typically called during server startup. It fetches all ready
     * plugins from the registry and attempts to activate them in parallel using
     * Promise.allSettled. Failures in individual plugins do not prevent others from loading.
     *
     * @returns A promise that resolves with summary statistics of the load operation.
     */
    async loadAll(): Promise<PluginLoadAllResult> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadAll: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      log.info("plugin-loader: loading all ready plugins");

      // Fetch all plugins in ready status, ordered by installOrder
      const readyPlugins = (await registry.listByStatus("ready")) as PluginRecord[];

      if (readyPlugins.length === 0) {
        log.info("plugin-loader: no ready plugins to load");
        return { total: 0, succeeded: 0, failed: 0, results: [] };
      }

      log.info(
        { count: readyPlugins.length },
        "plugin-loader: found ready plugins to load",
      );

      // Load plugins in parallel
      const results = await Promise.allSettled(
        readyPlugins.map((plugin) => activatePlugin(plugin))
      );

      const loadResults = results.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return {
          plugin: readyPlugins[i]!,
          success: false,
          error: String(r.reason),
          registered: { worker: false, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      });

      const succeeded = loadResults.filter((r) => r.success).length;
      const failed = loadResults.filter((r) => !r.success).length;

      log.info(
        {
          total: readyPlugins.length,
          succeeded,
          failed,
        },
        "plugin-loader: loadAll complete",
      );

      return {
        total: readyPlugins.length,
        succeeded,
        failed,
        results: loadResults,
      };
    },

    // -----------------------------------------------------------------------
    // loadSingle
    // -----------------------------------------------------------------------

    /**
     * loadSingle — Loads and activates a single plugin by its ID.
     *
     * This method retrieves the plugin from the registry, ensures it's in a valid
     * state, and then calls activatePlugin to start its worker and register its
     * capabilities (tools, jobs, etc.).
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns A promise that resolves with the result of the activation.
     */
    async loadSingle(pluginId: string): Promise<PluginLoadResult> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot loadSingle: no PluginRuntimeServices provided. " +
            "Pass runtime services as the third argument to pluginLoader().",
        );
      }

      const plugin = (await registry.getById(pluginId)) as PluginRecord | null;
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }

      // If the plugin is in 'installed' status, transition it to 'ready' first.
      // lifecycleManager.load() transitions the status AND activates the plugin
      // via activateReadyPlugin() → loadSingle() (recursive call with 'ready'
      // status) → activatePlugin(). We must NOT call activatePlugin() again here,
      // as that would double-start the worker and duplicate registrations.
      if (plugin.status === "installed") {
        await runtimeServices.lifecycleManager.load(pluginId);
        const updated = (await registry.getById(pluginId)) as PluginRecord | null;
        if (!updated) throw new Error(`Plugin not found after status update: ${pluginId}`);
        return {
          plugin: updated,
          success: true,
          registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
        };
      }

      if (plugin.status !== "ready") {
        throw new Error(
          `Cannot load plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'installed' or 'ready' status.`,
        );
      }

      return activatePlugin(plugin);
    },

    // -----------------------------------------------------------------------
    // unloadSingle
    // -----------------------------------------------------------------------

    async unloadSingle(pluginId: string, pluginKey: string): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot unloadSingle: no PluginRuntimeServices provided.",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: unloading single plugin",
      );

      const {
        workerManager,
        eventBus,
        jobScheduler,
        toolDispatcher,
      } = runtimeServices;

      // 1. Unregister from job scheduler (cancels in-flight runs)
      try {
        await jobScheduler.unregisterPlugin(pluginId);
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to unregister from job scheduler (best-effort)",
        );
      }

      // 2. Clear event subscriptions
      eventBus.clearPlugin(pluginKey);

      // 3. Unregister agent tools
      toolDispatcher.unregisterPluginTools(pluginKey);

      // 4. Stop the worker process
      try {
        if (workerManager.isRunning(pluginId)) {
          await workerManager.stopWorker(pluginId);
        }
      } catch (err) {
        log.warn(
          { pluginId, err: err instanceof Error ? err.message : String(err) },
          "plugin-loader: failed to stop worker during unload (best-effort)",
        );
      }

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: plugin unloaded successfully",
      );
    },

    // -----------------------------------------------------------------------
    // shutdownAll
    // -----------------------------------------------------------------------

    async shutdownAll(): Promise<void> {
      if (!runtimeServices) {
        throw new Error(
          "Cannot shutdownAll: no PluginRuntimeServices provided.",
        );
      }

      log.info("plugin-loader: shutting down all plugins");

      const { workerManager, jobScheduler } = runtimeServices;

      // 1. Stop the job scheduler tick loop
      jobScheduler.stop();

      // 2. Stop all worker processes
      await workerManager.stopAll();

      log.info("plugin-loader: all plugins shut down");
    },
  };

  // -------------------------------------------------------------------------
  // Internal: activatePlugin — shared logic for loadAll and loadSingle
  // -------------------------------------------------------------------------

  /**
   * Activate a single plugin: spawn its worker, register event subscriptions,
   * sync jobs, register tools.
   *
   * This is the core orchestration logic shared by `loadAll()` and `loadSingle()`.
   * Failures are caught and reported in the result; the plugin is marked as
   * `error` in the database when activation fails.
   */
  async function activatePlugin(plugin: PluginRecord): Promise<PluginLoadResult> {
    const manifest = plugin.manifestJson;
    const pluginId = plugin.id;
    const pluginKey = plugin.pluginKey;

    const registered: PluginLoadResult["registered"] = {
      worker: false,
      eventSubscriptions: 0,
      jobs: 0,
      webhooks: 0,
      tools: 0,
    };

    // Guard: runtime services must exist (callers already checked)
    if (!runtimeServices) {
      return {
        plugin,
        success: false,
        error: "No runtime services available",
        registered,
      };
    }

    const {
      workerManager,
      eventBus,
      jobScheduler,
      jobStore,
      toolDispatcher,
      lifecycleManager,
      buildHostHandlers,
      instanceInfo,
    } = runtimeServices;

    try {
      log.info(
        { pluginId, pluginKey, version: plugin.version },
        "plugin-loader: activating plugin",
      );

      // ------------------------------------------------------------------
      // 1. Resolve worker entrypoint
      // ------------------------------------------------------------------
      const workerEntrypoint = resolveWorkerEntrypoint(plugin, localPluginDir);

      // ------------------------------------------------------------------
      // 2. Build host handlers for this plugin
      // ------------------------------------------------------------------
      const hostHandlers = buildHostHandlers(pluginId, manifest);

      // ------------------------------------------------------------------
      // 3. Retrieve plugin config (if any)
      // ------------------------------------------------------------------
      let config: Record<string, unknown> = {};
      try {
        const configRow = await registry.getConfig(pluginId);
        if (configRow && typeof configRow === "object" && "configJson" in configRow) {
          config = (configRow as { configJson: Record<string, unknown> }).configJson ?? {};
        }
      } catch {
        // Config may not exist yet — use empty object
        log.debug({ pluginId }, "plugin-loader: no config found, using empty config");
      }

      // ------------------------------------------------------------------
      // 4. Spawn worker process
      // ------------------------------------------------------------------
      const workerOptions: WorkerStartOptions = {
        entrypointPath: workerEntrypoint,
        manifest,
        config,
        instanceInfo,
        apiVersion: manifest.apiVersion,
        hostHandlers,
        autoRestart: true,
      };

      // Repo-local plugin installs can resolve workspace TS sources at runtime
      // (for example @rudderhq/shared exports). Run those workers through
      // the tsx loader so first-party example plugins work in development.
      if (plugin.packagePath && existsSync(DEV_TSX_LOADER_PATH)) {
        workerOptions.execArgv = ["--import", DEV_TSX_LOADER_PATH];
      }

      await workerManager.startWorker(pluginId, workerOptions);
      registered.worker = true;

      log.info(
        { pluginId, pluginKey },
        "plugin-loader: worker started",
      );

      // ------------------------------------------------------------------
      // 5. Sync job declarations and register with scheduler
      // ------------------------------------------------------------------
      const jobDeclarations = manifest.jobs ?? [];
      if (jobDeclarations.length > 0) {
        await jobStore.syncJobDeclarations(pluginId, jobDeclarations);
        await jobScheduler.registerPlugin(pluginId);
        registered.jobs = jobDeclarations.length;

        log.info(
          { pluginId, pluginKey, jobs: jobDeclarations.length },
          "plugin-loader: job declarations synced and plugin registered with scheduler",
        );
      }

      // ------------------------------------------------------------------
      // 6. Register event subscriptions
      //
      // Note: Event subscriptions are declared at runtime by the plugin
      // worker via the SDK's ctx.events.on() calls. The event bus manages
      // per-plugin subscription scoping. Here we ensure the event bus has
      // a scoped handle ready for this plugin — the actual subscriptions
      // are registered by the host handler layer when the worker calls
      // events.subscribe via RPC.
      //
      // The bus.forPlugin() call creates the scoped handle if needed;
      // any previous subscriptions for this plugin are preserved if the
      // worker is restarting.
      // ------------------------------------------------------------------
      const _scopedBus = eventBus.forPlugin(pluginKey);
      registered.eventSubscriptions = eventBus.subscriptionCount(pluginKey);

      log.debug(
        { pluginId, pluginKey },
        "plugin-loader: event bus scoped handle ready",
      );

      // ------------------------------------------------------------------
      // 7. Register webhook endpoints (manifest-declared)
      //
      // Webhooks are statically declared in the manifest. The actual
      // endpoint routing is handled by the plugin routes module which
      // checks the manifest for declared webhooks. No explicit
      // registration step is needed here — the manifest is persisted
      // in the DB and the route handler reads it at request time.
      //
      // We track the count for the result reporting.
      // ------------------------------------------------------------------
      const webhookDeclarations = manifest.webhooks ?? [];
      registered.webhooks = webhookDeclarations.length;

      if (webhookDeclarations.length > 0) {
        log.info(
          { pluginId, pluginKey, webhooks: webhookDeclarations.length },
          "plugin-loader: webhook endpoints declared in manifest",
        );
      }

      // ------------------------------------------------------------------
      // 8. Register agent tools
      // ------------------------------------------------------------------
      const toolDeclarations = manifest.tools ?? [];
      if (toolDeclarations.length > 0) {
        toolDispatcher.registerPluginTools(pluginKey, manifest, pluginId);
        registered.tools = toolDeclarations.length;

        log.info(
          { pluginId, pluginKey, tools: toolDeclarations.length },
          "plugin-loader: agent tools registered",
        );
      }

      // ------------------------------------------------------------------
      // Done — plugin fully activated
      // ------------------------------------------------------------------
      log.info(
        {
          pluginId,
          pluginKey,
          version: plugin.version,
          registered,
        },
        "plugin-loader: plugin activated successfully",
      );

      return { plugin, success: true, registered };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error(
        { pluginId, pluginKey, err: errorMessage },
        "plugin-loader: failed to activate plugin",
      );

      // Mark the plugin as errored in the database so it is not retried
      // automatically on next startup without operator intervention.
      try {
        await lifecycleManager.markError(pluginId, `Activation failed: ${errorMessage}`);
      } catch (markErr) {
        log.error(
          {
            pluginId,
            err: markErr instanceof Error ? markErr.message : String(markErr),
          },
          "plugin-loader: failed to mark plugin as error after activation failure",
        );
      }

      return {
        plugin,
        success: false,
        error: errorMessage,
        registered,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a plugin's worker entrypoint from its manifest
 * and known install locations.
 *
 * The manifest `entrypoints.worker` field is relative to the package root.
 * We check the local plugin directory (where the package was installed) and
 * also the package directory if it was a local-path install.
 *
 * @see doc/engineering/PLUGIN_RUNTIME_CONTRACT.md — Package Contract
 */
