/**
 * @fileoverview Plugin management REST API routes
 *
 * This module provides Express routes for managing the complete plugin lifecycle:
 * - Listing and filtering plugins by status
 * - Installing plugins from npm or local paths
 * - Uninstalling plugins (soft delete or hard purge)
 * - Enabling/disabling plugins
 * - Running health diagnostics
 * - Upgrading plugins
 * - Retrieving UI slot contributions for frontend rendering
 * - Discovering and executing plugin-contributed agent tools
 *
 * All routes require board-level authentication (assertBoard middleware).
 *
 * @module server/routes/plugins
 * @see doc/plugins/PLUGIN_SPEC.md for the full plugin specification
 */

import type { Db } from "@rudderhq/db";
import { organizations } from "@rudderhq/db";
import type { ToolRunContext } from "@rudderhq/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@rudderhq/plugin-sdk";
import type {
  PaperclipPluginManifestV1,
  PluginBridgeErrorCode,
  PluginLauncherRenderContextSnapshot,
  PluginStatus,
} from "@rudderhq/shared";
import {
  PLUGIN_STATUSES,
} from "@rudderhq/shared";
import type { Request } from "express";
import { Router } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logActivity } from "../services/activity-log.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { getPluginUiContributionMetadata, pluginLoader } from "../services/plugin-loader.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import type { PluginStreamBus } from "../services/plugin-stream-bus.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { registerPluginOperationsRoutes } from "./plugins.operations-routes.js";

/** UI slot declaration extracted from plugin manifest */
type PluginUiSlotDeclaration = NonNullable<NonNullable<PaperclipPluginManifestV1["ui"]>["slots"]>[number];
/** Launcher declaration extracted from plugin manifest */
type PluginLauncherDeclaration = NonNullable<PaperclipPluginManifestV1["launchers"]>[number];

/**
 * Normalized UI contribution for frontend slot host consumption.
 * Only includes plugins in 'ready' state with non-empty slot declarations.
 */
type PluginUiContribution = {
  pluginId: string;
  pluginKey: string;
  displayName: string;
  version: string;
  updatedAt: string;
  /**
   * Relative path within the plugin's UI directory to the entry module
   * (e.g. `"index.js"`). The frontend constructs the full import URL as
   * `/_plugins/${pluginId}/ui/${uiEntryFile}`.
   */
  uiEntryFile: string;
  slots: PluginUiSlotDeclaration[];
  launchers: PluginLauncherDeclaration[];
};

/** Request body for POST /api/plugins/install */
interface PluginInstallRequest {
  /** npm package name (e.g., @rudderhq/plugin-linear) or local path */
  packageName: string;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
}

interface AvailablePluginCatalogEntry {
  packageName: string;
  pluginKey: string;
  displayName: string;
  description: string;
  localPath: string;
  tag: "available" | "example";
}

/** Response body for GET /api/plugins/:pluginId/health */
interface PluginHealthCheckResult {
  pluginId: string;
  status: string;
  healthy: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message?: string;
  }>;
  lastError?: string;
}

/** UUID v4 regex used for plugin ID route resolution. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER_PACKAGE_ROOT = path.resolve(__dirname, "../..");

const BUNDLED_PLUGIN_CATALOG: AvailablePluginCatalogEntry[] = [
  {
    packageName: "@rudderhq/plugin-file-browser-example",
    pluginKey: "rudder-file-browser-example",
    displayName: "File Browser (Example)",
    description: "Example plugin that adds a Files link in project navigation plus a project detail file browser.",
    localPath: "packages/plugins/examples/plugin-file-browser-example",
    tag: "example",
  },
  {
    packageName: "@rudderhq/plugin-kitchen-sink-example",
    pluginKey: "rudder-kitchen-sink-example",
    displayName: "Kitchen Sink (Example)",
    description: "Reference plugin that demonstrates the current Rudder plugin API surface, bridge flows, UI extension surfaces, jobs, webhooks, tools, streams, and trusted local workspace/process demos.",
    localPath: "packages/plugins/examples/plugin-kitchen-sink-example",
    tag: "example",
  },
  {
    packageName: "@rudderhq/plugin-linear",
    pluginKey: "rudder.linear",
    displayName: "Linear",
    description: "Import-first Linear connector for Rudder issues.",
    localPath: "packages/plugins/examples/plugin-linear",
    tag: "available",
  },
];

function resolveBundledPluginPath(plugin: AvailablePluginCatalogEntry): string | null {
  const sourceCheckoutPath = path.resolve(REPO_ROOT, plugin.localPath);
  if (existsSync(sourceCheckoutPath)) return sourceCheckoutPath;

  const packagedPath = path.resolve(SERVER_PACKAGE_ROOT, "dist/bundled-plugins", path.basename(plugin.localPath));
  if (existsSync(packagedPath)) return packagedPath;

  return null;
}

function listBundledPlugins(): AvailablePluginCatalogEntry[] {
  return BUNDLED_PLUGIN_CATALOG.flatMap((plugin) => {
    const resolvedLocalPath = resolveBundledPluginPath(plugin);
    if (!resolvedLocalPath) return [];
    return [{ ...plugin, localPath: resolvedLocalPath }];
  });
}

function listBundledPluginExamples(): AvailablePluginCatalogEntry[] {
  return listBundledPlugins().filter((plugin) => plugin.tag === "example");
}

/**
 * Resolve a plugin by either database ID or plugin key.
 *
 * Lookup order:
 * - UUID-like IDs: getById first, then getByKey.
 * - Scoped package keys (e.g. "@scope/name"): getByKey only, never getById.
 * - Other non-UUID IDs: try getById first (test/memory registries may allow this),
 *   then fallback to getByKey. Any UUID parse error from getById is ignored.
 *
 * @param registry - The plugin registry service instance
 * @param pluginId - Either a database UUID or plugin key (manifest id)
 * @returns Plugin record or null if not found
 */
async function resolvePlugin(
  registry: ReturnType<typeof pluginRegistryService>,
  pluginId: string,
) {
  const isUuid = UUID_REGEX.test(pluginId);
  const isScopedPackageKey = pluginId.startsWith("@") || pluginId.includes("/");

  // Scoped package IDs are valid plugin keys but invalid UUIDs.
  // Skip getById() entirely to avoid Postgres uuid parse errors.
  if (isScopedPackageKey && !isUuid) {
    return registry.getByKey(pluginId);
  }

  try {
    const byId = await registry.getById(pluginId);
    if (byId) return byId;
  } catch (error) {
    const maybeCode =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    // Ignore invalid UUID cast errors and continue with key lookup.
    if (maybeCode !== "22P02") {
      throw error;
    }
  }

  return registry.getByKey(pluginId);
}

/**
 * Optional dependencies for plugin job scheduling routes.
 *
 * When provided, job-related routes (list jobs, list runs, trigger job) are
 * mounted. When omitted, the routes return 501 Not Implemented.
 */
export interface PluginRouteJobDeps {
  /** The job scheduler instance. */
  scheduler: PluginJobScheduler;
  /** The job persistence store. */
  jobStore: PluginJobStore;
}

/**
 * Optional dependencies for plugin webhook routes.
 *
 * When provided, the webhook ingestion route is enabled. When omitted,
 * webhook POST requests return 501 Not Implemented.
 */
export interface PluginRouteWebhookDeps {
  /** The worker manager for dispatching handleWebhook RPC calls. */
  workerManager: PluginWorkerManager;
}

/**
 * Optional dependencies for plugin tool routes.
 *
 * When provided, tool discovery and execution routes are enabled.
 * When omitted, the tool routes return 501 Not Implemented.
 */
export interface PluginRouteToolDeps {
  /** The tool dispatcher for listing and executing plugin tools. */
  toolDispatcher: PluginToolDispatcher;
}

/**
 * Optional dependencies for plugin UI bridge routes.
 *
 * When provided, the getData and performAction bridge proxy routes are enabled,
 * allowing plugin UI components to communicate with their worker backend via
 * `usePluginData()` and `usePluginAction()` hooks.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export interface PluginRouteBridgeDeps {
  /** The worker manager for dispatching getData/performAction RPC calls. */
  workerManager: PluginWorkerManager;
  /** Optional stream bus for SSE push from worker to UI. */
  streamBus?: PluginStreamBus;
}

/** Request body for POST /api/plugins/tools/execute */
interface PluginToolExecuteRequest {
  /** Fully namespaced tool name (e.g., "acme.linear:search-issues"). */
  tool: string;
  /** Parameters matching the tool's declared JSON Schema. */
  parameters?: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
}

/**
 * Create Express router for plugin management API.
 *
 * Routes provided:
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | /plugins | List all plugins (optional ?status= filter) |
 * | GET | /plugins/ui-contributions | Get UI slots from ready plugins |
 * | GET | /plugins/:pluginId | Get single plugin by ID or key |
 * | POST | /plugins/install | Install from npm or local path |
 * | DELETE | /plugins/:pluginId | Uninstall (optional ?purge=true) |
 * | POST | /plugins/:pluginId/enable | Enable a plugin |
 * | POST | /plugins/:pluginId/disable | Disable a plugin |
 * | GET | /plugins/:pluginId/health | Run health diagnostics |
 * | POST | /plugins/:pluginId/upgrade | Upgrade to newer version |
 * | GET | /plugins/:pluginId/jobs | List jobs for a plugin |
 * | GET | /plugins/:pluginId/jobs/:jobId/runs | List runs for a job |
 * | POST | /plugins/:pluginId/jobs/:jobId/trigger | Manually trigger a job |
 * | POST | /plugins/:pluginId/webhooks/:endpointKey | Receive inbound webhook |
 * | GET | /plugins/tools | List all available plugin tools |
 * | GET | /plugins/tools?pluginId=... | List tools for a specific plugin |
 * | POST | /plugins/tools/execute | Execute a plugin tool |
 * | GET | /plugins/:pluginId/config | Get current plugin config |
 * | POST | /plugins/:pluginId/config | Save (upsert) plugin config |
 * | POST | /plugins/:pluginId/config/test | Test config via validateConfig RPC |
 * | POST | /plugins/:pluginId/bridge/data | Proxy getData to plugin worker |
 * | POST | /plugins/:pluginId/bridge/action | Proxy performAction to plugin worker |
 * | POST | /plugins/:pluginId/data/:key | Proxy getData to plugin worker (key in URL) |
 * | POST | /plugins/:pluginId/actions/:key | Proxy performAction to plugin worker (key in URL) |
 * | GET | /plugins/:pluginId/bridge/stream/:channel | SSE stream from worker to UI |
 * | GET | /plugins/:pluginId/dashboard | Aggregated health dashboard data |
 *
 * **Route Ordering Note:** Static routes (like /ui-contributions, /tools) must be
 * registered before parameterized routes (like /:pluginId) to prevent Express from
 * matching them as a plugin ID.
 *
 * @param db - Database connection instance
 * @param jobDeps - Optional job scheduling dependencies
 * @param webhookDeps - Optional webhook ingestion dependencies
 * @param toolDeps - Optional tool dispatcher dependencies
 * @param bridgeDeps - Optional bridge proxy dependencies for getData/performAction
 * @returns Express router with plugin routes mounted
 */
export function pluginRoutes(
  db: Db,
  loader: ReturnType<typeof pluginLoader>,
  jobDeps?: PluginRouteJobDeps,
  webhookDeps?: PluginRouteWebhookDeps,
  toolDeps?: PluginRouteToolDeps,
  bridgeDeps?: PluginRouteBridgeDeps,
) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const lifecycle = pluginLifecycleManager(db, {
    loader,
    workerManager: bridgeDeps?.workerManager ?? webhookDeps?.workerManager,
  });

  async function resolvePluginAuditCompanyIds(req: Request): Promise<string[]> {
    if (typeof (db as { select?: unknown }).select === "function") {
      const rows = await db
        .select({ id: organizations.id })
        .from(organizations);
      return rows.map((row) => row.id);
    }

    if (req.actor.type === "agent" && req.actor.orgId) {
      return [req.actor.orgId];
    }

    if (req.actor.type === "board") {
      return req.actor.orgIds ?? [];
    }

    return [];
  }

  async function logPluginMutationActivity(
    req: Request,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const orgIds = await resolvePluginAuditCompanyIds(req);
    if (orgIds.length === 0) return;

    const actor = getActorInfo(req);
    await Promise.all(orgIds.map((orgId) =>
      logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action,
        entityType: "plugin",
        entityId,
        details,
      })));
  }

  /**
   * GET /api/plugins
   *
   * List all installed plugins, optionally filtered by lifecycle status.
   *
   * Query params:
   * - `status` (optional): Filter by lifecycle status. Must be one of the
   *   values in `PLUGIN_STATUSES` (`installed`, `ready`, `error`,
   *   `upgrade_pending`, `uninstalled`). Returns HTTP 400 if the value is
   *   not a recognised status string.
   *
   * Response: `PluginRecord[]`
   */
  router.get("/plugins", async (req, res) => {
    assertBoard(req);
    const rawStatus = req.query.status;
    if (rawStatus !== undefined) {
      if (typeof rawStatus !== "string" || !(PLUGIN_STATUSES as readonly string[]).includes(rawStatus)) {
        res.status(400).json({
          error: `Invalid status '${String(rawStatus)}'. Must be one of: ${PLUGIN_STATUSES.join(", ")}`,
        });
        return;
      }
    }
    const status = rawStatus as PluginStatus | undefined;
    const plugins = status
      ? await registry.listByStatus(status)
      : await registry.listInstalled();
    res.json(plugins);
  });

  /**
   * GET /api/plugins/examples
   *
   * Return first-party example plugins bundled in this repo, if present.
   * These can be installed through the normal local-path install flow.
   */
  router.get("/plugins/examples", async (req, res) => {
    assertBoard(req);
    res.json(listBundledPluginExamples());
  });

  /**
   * GET /api/plugins/available
   *
   * Return first-party plugins available for one-click local-path install.
   * Production builds can include non-example plugins in this catalog.
   */
  router.get("/plugins/available", async (req, res) => {
    assertBoard(req);
    res.json(listBundledPlugins());
  });

  // IMPORTANT: Static routes must come before parameterized routes
  // to avoid Express matching "ui-contributions" as a :pluginId

  /**
   * GET /api/plugins/ui-contributions
   *
   * Return UI contributions from all plugins in 'ready' state.
   * Used by the frontend to discover plugin UI slots and launcher metadata.
   *
   * The response is normalized for the frontend slot host:
   * - Only includes plugins with at least one declared UI slot or launcher
   * - Excludes plugins with null/missing manifestJson (defensive)
   * - Slots are extracted from manifest.ui.slots
   * - Launchers are aggregated from legacy manifest.launchers and manifest.ui.launchers
   *
   * Example response:
   * ```json
   * [
   *   {
   *     "pluginId": "plg_123",
   *     "pluginKey": "rudder.claude-usage",
   *     "displayName": "Claude Usage",
   *     "version": "1.0.0",
   *     "uiEntryFile": "index.js",
   *     "slots": [],
   *     "launchers": [
   *       {
   *         "id": "claude-usage-toolbar",
   *         "displayName": "Claude Usage",
   *         "placementZone": "toolbarButton",
   *         "action": { "type": "openModal", "target": "ClaudeUsageView" },
   *         "render": { "environment": "hostOverlay", "bounds": "wide" }
   *       }
   *     ]
   *   }
   * ]
   * ```
   *
   * Response: PluginUiContribution[]
   */
  router.get("/plugins/ui-contributions", async (req, res) => {
    assertBoard(req);
    const plugins = await registry.listByStatus("ready");

    const contributions: PluginUiContribution[] = plugins
      .map((plugin) => {
        // Safety check: manifestJson should always exist for ready plugins, but guard against null
        const manifest = plugin.manifestJson;
        if (!manifest) return null;

        const uiMetadata = getPluginUiContributionMetadata(manifest);
        if (!uiMetadata) return null;

        return {
          pluginId: plugin.id,
          pluginKey: plugin.pluginKey,
          displayName: manifest.displayName,
          version: plugin.version,
          updatedAt: plugin.updatedAt.toISOString(),
          uiEntryFile: uiMetadata.uiEntryFile,
          slots: uiMetadata.slots,
          launchers: uiMetadata.launchers,
        };
      })
      .filter((item): item is PluginUiContribution => item !== null);
    res.json(contributions);
  });

  // ===========================================================================
  // Tool discovery and execution routes
  // ===========================================================================

  /**
   * GET /api/plugins/tools
   *
   * List all available plugin-contributed tools in an agent-friendly format.
   *
   * Query params:
   * - `pluginId` (optional): Filter to tools from a specific plugin
   *
   * Response: `AgentToolDescriptor[]`
   * Errors: 501 if tool dispatcher is not configured
   */
  router.get("/plugins/tools", async (req, res) => {
    assertBoard(req);

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled" });
      return;
    }

    const pluginId = req.query.pluginId as string | undefined;
    const filter = pluginId ? { pluginId } : undefined;
    const tools = toolDeps.toolDispatcher.listToolsForAgent(filter);
    res.json(tools);
  });

  /**
   * POST /api/plugins/tools/execute
   *
   * Execute a plugin-contributed tool by its namespaced name.
   *
   * This is the primary endpoint used by the agent service to invoke
   * plugin tools during an agent run.
   *
   * Request body:
   * - `tool`: Fully namespaced tool name (e.g., "acme.linear:search-issues")
   * - `parameters`: Parameters matching the tool's declared JSON Schema
   * - `runContext`: Agent run context with agentId, runId, orgId, projectId
   *
   * Response: `ToolExecutionResult`
   * Errors:
   * - 400 if request validation fails
   * - 404 if tool is not found
   * - 501 if tool dispatcher is not configured
   * - 502 if the plugin worker is unavailable or the RPC call fails
   */
  router.post("/plugins/tools/execute", async (req, res) => {
    assertBoard(req);

    if (!toolDeps) {
      res.status(501).json({ error: "Plugin tool dispatch is not enabled" });
      return;
    }

    const body = (req.body as PluginToolExecuteRequest | undefined);
    if (!body) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }

    const { tool, parameters, runContext } = body;

    // Validate required fields
    if (!tool || typeof tool !== "string") {
      res.status(400).json({ error: '"tool" is required and must be a string' });
      return;
    }

    if (!runContext || typeof runContext !== "object") {
      res.status(400).json({ error: '"runContext" is required and must be an object' });
      return;
    }

    if (!runContext.agentId || !runContext.runId || !runContext.orgId || !runContext.projectId) {
      res.status(400).json({
        error: '"runContext" must include agentId, runId, orgId, and projectId',
      });
      return;
    }

    assertCompanyAccess(req, runContext.orgId);

    // Verify the tool exists
    const registeredTool = toolDeps.toolDispatcher.getTool(tool);
    if (!registeredTool) {
      res.status(404).json({ error: `Tool "${tool}" not found` });
      return;
    }

    try {
      const result = await toolDeps.toolDispatcher.executeTool(
        tool,
        parameters ?? {},
        runContext,
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish between "worker not running" (502) and other errors (500)
      if (message.includes("not running") || message.includes("worker")) {
        res.status(502).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  /**
   * POST /api/plugins/install
   *
   * Install a plugin from npm or a local filesystem path.
   *
   * Request body:
   * - packageName: npm package name or local path (required)
   * - version: Target version for npm packages (optional)
   * - isLocalPath: Set true if packageName is a local path
   *
   * The installer:
   * 1. Downloads from npm or loads from local path
   * 2. Validates the manifest (schema + capability consistency)
   * 3. Registers in the database
   * 4. Transitions to `ready` state if no new capability approval is needed
   *
   * Response: `PluginRecord`
   *
   * Errors:
   * - `400` — validation failure or install error (package not found, bad manifest, etc.)
   * - `500` — installation succeeded but manifest is missing (indicates a loader bug)
   */
  router.post("/plugins/install", async (req, res) => {
    assertBoard(req);
    const { packageName, version, isLocalPath } = req.body as PluginInstallRequest;

    // Input validation
    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required and must be a string" });
      return;
    }

    if (version !== undefined && typeof version !== "string") {
      res.status(400).json({ error: "version must be a string if provided" });
      return;
    }

    if (isLocalPath !== undefined && typeof isLocalPath !== "boolean") {
      res.status(400).json({ error: "isLocalPath must be a boolean if provided" });
      return;
    }

    // Validate package name format
    const trimmedPackage = packageName.trim();
    if (trimmedPackage.length === 0) {
      res.status(400).json({ error: "packageName cannot be empty" });
      return;
    }

    // Basic security check for package name (prevent injection)
    if (!isLocalPath && /[<>:"|?*]/.test(trimmedPackage)) {
      res.status(400).json({ error: "packageName contains invalid characters" });
      return;
    }

    try {
      const installOptions = isLocalPath
        ? { localPath: trimmedPackage }
        : { packageName: trimmedPackage, version: version?.trim() };

      const discovered = await loader.installPlugin(installOptions);

      if (!discovered.manifest) {
        res.status(500).json({ error: "Plugin installed but manifest is missing" });
        return;
      }

      // Transition to ready state
      const existingPlugin = await registry.getByKey(discovered.manifest.id);
      if (existingPlugin) {
        await lifecycle.load(existingPlugin.id);
        const updated = await registry.getById(existingPlugin.id);
        await logPluginMutationActivity(req, "plugin.installed", existingPlugin.id, {
          pluginId: existingPlugin.id,
          pluginKey: existingPlugin.pluginKey,
          packageName: updated?.packageName ?? existingPlugin.packageName,
          version: updated?.version ?? existingPlugin.version,
          source: isLocalPath ? "local_path" : "npm",
        });
        publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: existingPlugin.id, action: "installed" } });
        res.json(updated);
      } else {
        // This shouldn't happen since installPlugin already registers in the DB
        res.status(500).json({ error: "Plugin installed but not found in registry" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // UI Bridge proxy routes (getData / performAction)
  // ===========================================================================

  /** Request body for POST /api/plugins/:pluginId/bridge/data */
  interface PluginBridgeDataRequest {
    /** Plugin-defined data key (e.g. `"sync-health"`). */
    key: string;
    /** Optional organization scope for authorizing organization-context bridge calls. */
    orgId?: string;
    /** Optional context and query parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Request body for POST /api/plugins/:pluginId/bridge/action */
  interface PluginBridgeActionRequest {
    /** Plugin-defined action key (e.g. `"resync"`). */
    key: string;
    /** Optional organization scope for authorizing organization-context bridge calls. */
    orgId?: string;
    /** Optional parameters from the UI. */
    params?: Record<string, unknown>;
    /** Optional host launcher/render metadata for the worker bridge call. */
    renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
  }

  /** Response envelope for bridge errors. */
  interface PluginBridgeErrorResponse {
    code: PluginBridgeErrorCode;
    message: string;
    details?: unknown;
  }

  /**
   * Map a worker RPC error to a bridge-level error code.
   *
   * JsonRpcCallError carries numeric codes from the plugin RPC error code space.
   * This helper maps them to the string error codes defined in PluginBridgeErrorCode.
   *
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  function mapRpcErrorToBridgeError(err: unknown): PluginBridgeErrorResponse {
    if (err instanceof JsonRpcCallError) {
      switch (err.code) {
        case PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE:
          return {
            code: "WORKER_UNAVAILABLE",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED:
          return {
            code: "CAPABILITY_DENIED",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.TIMEOUT:
          return {
            code: "TIMEOUT",
            message: err.message,
            details: err.data,
          };
        case PLUGIN_RPC_ERROR_CODES.WORKER_ERROR:
          return {
            code: "WORKER_ERROR",
            message: err.message,
            details: err.data,
          };
        default:
          return {
            code: "UNKNOWN",
            message: err.message,
            details: err.data,
          };
      }
    }

    const message = err instanceof Error ? err.message : String(err);

    // Worker not running — surface as WORKER_UNAVAILABLE
    if (message.includes("not running") || message.includes("not registered")) {
      return {
        code: "WORKER_UNAVAILABLE",
        message,
      };
    }

    return {
      code: "UNKNOWN",
      message,
    };
  }

  /**
   * POST /api/plugins/:pluginId/bridge/data
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginData(key, params)` bridge hook.
   * The frontend sends a POST with the data key and optional params; the host
   * forwards the call to the worker via the `getData` RPC method and returns
   * the result.
   *
   * Request body:
   * - `key`: Plugin-defined data key (e.g. `"sync-health"`)
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/data", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeDataRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.orgId) {
      assertCompanyAccess(req, body.orgId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/bridge/action
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker.
   *
   * This is the server-side half of the `usePluginAction(key)` bridge hook.
   * The frontend sends a POST with the action key and optional params; the host
   * forwards the call to the worker via the `performAction` RPC method and
   * returns the result.
   *
   * Request body:
   * - `key`: Plugin-defined action key (e.g. `"resync"`)
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/bridge/action", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    // Validate request body
    const body = req.body as PluginBridgeActionRequest | undefined;
    if (!body || !body.key || typeof body.key !== "string") {
      res.status(400).json({ error: '"key" is required and must be a string' });
      return;
    }

    if (body.orgId) {
      assertCompanyAccess(req, body.orgId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key: body.key,
          params: body.params ?? {},
          renderEnvironment: body.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // URL-keyed bridge routes (key as path parameter)
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/data/:key
   *
   * Proxy a `getData` call from the plugin UI to the plugin worker, with the
   * data key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/data`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional query parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `getData` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.8 — `getData`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/data/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as {
      orgId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined;

    if (body?.orgId) {
      assertCompanyAccess(req, body.orgId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "getData",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  /**
   * POST /api/plugins/:pluginId/actions/:key
   *
   * Proxy a `performAction` call from the plugin UI to the plugin worker, with
   * the action key specified as a URL path parameter instead of in the request body.
   *
   * This is a REST-friendly alternative to `POST /plugins/:pluginId/bridge/action`.
   * The frontend bridge hooks use this endpoint for cleaner URLs.
   *
   * Request body (optional):
   * - `params`: Optional parameters forwarded to the worker handler
   *
   * Response: The raw result from the worker's `performAction` handler wrapped as `{ data: T }`
   *
   * Error response body follows the `PluginBridgeError` shape:
   * `{ code: PluginBridgeErrorCode, message: string, details?: unknown }`
   *
   * Errors:
   * - 404 if plugin not found
   * - 501 if bridge deps are not configured
   * - 502 if the worker is unavailable or returns an error
   *
   * @see PLUGIN_SPEC.md §13.9 — `performAction`
   * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
   */
  router.post("/plugins/:pluginId/actions/:key", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId, key } = req.params;

    // Resolve plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Validate plugin is in ready state
    if (plugin.status !== "ready") {
      const bridgeError: PluginBridgeErrorResponse = {
        code: "WORKER_UNAVAILABLE",
        message: `Plugin is not ready (current status: ${plugin.status})`,
      };
      res.status(502).json(bridgeError);
      return;
    }

    const body = req.body as {
      orgId?: string;
      params?: Record<string, unknown>;
      renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
    } | undefined;

    if (body?.orgId) {
      assertCompanyAccess(req, body.orgId);
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "performAction",
        {
          key,
          params: body?.params ?? {},
          renderEnvironment: body?.renderEnvironment ?? null,
        },
      );
      res.json({ data: result });
    } catch (err) {
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // SSE stream bridge route
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/bridge/stream/:channel
   *
   * Server-Sent Events endpoint for real-time streaming from plugin worker to UI.
   *
   * The worker pushes events via `ctx.streams.emit(channel, event)` which arrive
   * as JSON-RPC notifications to the host, get published on the PluginStreamBus,
   * and are fanned out to all connected SSE clients matching (pluginId, channel,
   * orgId).
   *
   * Query parameters:
   * - `orgId` (required): Scope events to a specific organization
   *
   * SSE event types:
   * - `message`: A data event from the worker (default)
   * - `open`: The worker opened the stream channel
   * - `close`: The worker closed the stream channel — client should disconnect
   *
   * Errors:
   * - 400 if orgId is missing
   * - 404 if plugin not found
   * - 501 if bridge deps or stream bus are not configured
   */
  router.get("/plugins/:pluginId/bridge/stream/:channel", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps?.streamBus) {
      res.status(501).json({ error: "Plugin stream bridge is not enabled" });
      return;
    }

    const { pluginId, channel } = req.params;
    const orgId = req.query.orgId as string | undefined;

    if (!orgId) {
      res.status(400).json({ error: '"orgId" query parameter is required' });
      return;
    }

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    assertCompanyAccess(req, orgId);

    // Set SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Send initial comment to establish the connection
    res.write(":ok\n\n");

    let unsubscribed = false;
    const safeUnsubscribe = () => {
      if (!unsubscribed) {
        unsubscribed = true;
        unsubscribe();
      }
    };

    const unsubscribe = bridgeDeps.streamBus.subscribe(
      plugin.id,
      channel,
      orgId,
      (event, eventType) => {
        if (unsubscribed || !res.writable) return;
        try {
          if (eventType !== "message") {
            res.write(`event: ${eventType}\n`);
          }
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Connection closed or write error — stop delivering
          safeUnsubscribe();
        }
      },
    );

    req.on("close", safeUnsubscribe);
    res.on("error", safeUnsubscribe);
  });

  /**
   * GET /api/plugins/:pluginId
   *
   * Get detailed information about a single plugin.
   *
   * The :pluginId parameter accepts either:
   * - Database UUID (e.g., "abc123-def456")
   * - Plugin key (e.g., "acme.linear")
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Enrich with worker capabilities when available
    const worker = bridgeDeps?.workerManager.getWorker(plugin.id);
    const supportsConfigTest = worker
      ? worker.supportedMethods.includes("validateConfig")
      : false;

    res.json({ ...plugin, supportsConfigTest });
  });

  /**
   * DELETE /api/plugins/:pluginId
   *
   * Uninstall a plugin.
   *
   * Query params:
   * - purge: If "true", permanently delete all plugin data (hard delete)
   *          Otherwise, soft-delete with 30-day data retention
   *
   * Response: PluginRecord (the deleted record)
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.delete("/plugins/:pluginId", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const purge = req.query.purge === "true";

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.unload(plugin.id, purge);
      await logPluginMutationActivity(req, "plugin.uninstalled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        purge,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "uninstalled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/enable
   *
   * Enable a plugin that is currently disabled or in error state.
   *
   * Transitions the plugin to 'ready' state after loading and validation.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/enable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.enable(plugin.id);
      await logPluginMutationActivity(req, "plugin.enabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        version: result?.version ?? plugin.version,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "enabled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/disable
   *
   * Disable a running plugin.
   *
   * Request body (optional):
   * - reason: Human-readable reason for disabling
   *
   * The plugin transitions to 'installed' state and stops processing events.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/disable", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { reason?: string } | undefined;
    const reason = body?.reason;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      const result = await lifecycle.disable(plugin.id, reason);
      await logPluginMutationActivity(req, "plugin.disabled", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        reason: reason ?? null,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "disabled" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/health
   *
   * Run health diagnostics on a plugin.
   *
   * Performs the following checks:
   * 1. Registry: Plugin is registered in the database
   * 2. Manifest: Manifest is valid and parseable
   * 3. Status: Plugin is in 'ready' state
   * 4. Error state: Plugin has no unhandled errors
   *
   * Response: PluginHealthCheckResult
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/health", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const checks: PluginHealthCheckResult["checks"] = [];

    // Check 1: Plugin is registered
    checks.push({
      name: "registry",
      passed: true,
      message: "Plugin found in registry",
    });

    // Check 2: Manifest is valid
    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    // Check 3: Plugin status
    const isHealthy = plugin.status === "ready";
    checks.push({
      name: "status",
      passed: isHealthy,
      message: `Current status: ${plugin.status}`,
    });

    // Check 4: No last error
    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({
        name: "error_state",
        passed: false,
        message: plugin.lastError ?? undefined,
      });
    }

    const result: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    res.json(result);
  });

  /**
   * GET /api/plugins/:pluginId/logs
   *
   * Query recent log entries for a plugin.
   *
   * Query params:
   * - limit: Maximum number of entries (default 25, max 500)
   * - level: Filter by log level (info, warn, error, debug)
   * - since: ISO timestamp to filter logs newer than this time
   *
   * Response: Array of log entries, newest first.
   */
  registerPluginOperationsRoutes({
    router,
    db,
    loader,
    registry,
    lifecycle,
    bridgeDeps,
    jobDeps,
    webhookDeps,
    resolvePlugin,
    logPluginMutationActivity,
    mapRpcErrorToBridgeError,
  });
  return router;
}
