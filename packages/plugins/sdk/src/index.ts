/**
 * `@rudderhq/plugin-sdk` — Rudder plugin worker-side SDK.
 *
 * This is the main entrypoint for plugin worker code.  For plugin UI bundles,
 * import from `@rudderhq/plugin-sdk/ui` instead.
 *
 * @example
 * ```ts
 * // Plugin worker entrypoint (dist/worker.ts)
 * import { definePlugin, runWorker, z } from "@rudderhq/plugin-sdk";
 *
 * const plugin = definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Plugin starting up");
 *
 *     ctx.events.on("issue.created", async (event) => {
 *       ctx.logger.info("Issue created", { issueId: event.entityId });
 *     });
 *
 *     ctx.jobs.register("full-sync", async (job) => {
 *       ctx.logger.info("Starting full sync", { runId: job.runId });
 *       // ... sync implementation
 *     });
 *
 *     ctx.data.register("sync-health", async ({ orgId }) => {
 *       const state = await ctx.state.get({
 *         scopeKind: "company",
 *         scopeId: String(orgId),
 *         stateKey: "last-sync-at",
 *       });
 *       return { lastSync: state };
 *     });
 *   },
 *
 *   async onHealth() {
 *     return { status: "ok" };
 *   },
 * });
 *
 * export default plugin;
 * runWorker(plugin, import.meta.url);
 * ```
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

export { createPluginBundlerPresets } from "./bundlers.js";
export { definePlugin } from "./define-plugin.js";
export { getUiBuildSnapshot, startPluginDevServer } from "./dev-server.js";
export {
  CapabilityDeniedError, createHostClientHandlers,
  getRequiredCapability
} from "./host-client-factory.js";
export { createTestHarness } from "./testing.js";
export { runWorker, startWorkerRpcHost } from "./worker-rpc-host.js";

// JSON-RPC protocol helpers and constants
export {
  HOST_TO_WORKER_OPTIONAL_METHODS, HOST_TO_WORKER_REQUIRED_METHODS, JSONRPC_ERROR_CODES, JSONRPC_VERSION, JsonRpcCallError, JsonRpcParseError, MESSAGE_DELIMITER, PLUGIN_RPC_ERROR_CODES, _resetIdCounter, createErrorResponse,
  createNotification, createRequest,
  createSuccessResponse, isJsonRpcErrorResponse, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse,
  isJsonRpcSuccessResponse, parseMessage, serializeMessage
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Type exports
// ---------------------------------------------------------------------------

// Plugin definition and lifecycle types
export type {
  EsbuildLikeOptions, PluginBundlerPresetInput,
  PluginBundlerPresets, RollupLikeConfig
} from "./bundlers.js";
export type {
  PaperclipPlugin, PluginConfigValidationResult, PluginDefinition, PluginHealthDiagnostics, PluginWebhookInput
} from "./define-plugin.js";
export type { PluginDevServer, PluginDevServerOptions } from "./dev-server.js";
export type {
  HostClientFactoryOptions,
  HostClientHandlers, HostServices
} from "./host-client-factory.js";
export type {
  TestHarness, TestHarnessLogEntry, TestHarnessOptions
} from "./testing.js";
export type {
  RunWorkerOptions, WorkerRpcHost, WorkerRpcHostOptions
} from "./worker-rpc-host.js";

// JSON-RPC protocol types
export type {
  ConfigChangedParams, ExecuteToolParams, GetDataParams, HostToWorkerMethodName, HostToWorkerMethods, HostToWorkerRequest,
  HostToWorkerResponse, InitializeParams,
  InitializeResult, JsonRpcError, JsonRpcErrorCode, JsonRpcErrorResponse, JsonRpcId, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, JsonRpcSuccessResponse, OnEventParams, PerformActionParams, PluginLauncherRenderContextSnapshot, PluginModalBoundsRequest,
  PluginRenderCloseEvent, PluginRpcErrorCode, RunJobParams, ValidateConfigParams, WorkerToHostMethodName, WorkerToHostMethods, WorkerToHostNotificationName, WorkerToHostNotifications, WorkerToHostRequest,
  WorkerToHostResponse
} from "./protocol.js";

// Plugin context and all client interfaces
export type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionSendResult, PluginActionsClient, PluginActivityClient,
  PluginActivityLogEntry, PluginAgentSessionsClient, PluginAgentsClient, PluginConfigClient, PluginContext, PluginDataClient, PluginEntitiesClient, PluginEventsClient, PluginGoalsClient, PluginHttpClient, PluginIssuesClient, PluginJobsClient,
  PluginLaunchersClient, PluginLogger, PluginMetricsClient, PluginOrganizationsClient, PluginProjectsClient, PluginSecretsClient, PluginStateClient, PluginStreamsClient,
  PluginToolsClient
} from "./types.js";

// Supporting types for context clients
export type {
  Agent, EventFilter, Goal, Issue,
  IssueComment, Organization, PluginEntityQuery, PluginEntityRecord, PluginEntityUpsert, PluginEvent,
  PluginJobContext,
  PluginLauncherRegistration, PluginWorkspace, Project, ScopeKey, ToolResult, ToolRunContext
} from "./types.js";

// Manifest and constant types re-exported from @rudderhq/shared
// Plugin authors import manifest types from here so they have a single
// dependency (@rudderhq/plugin-sdk) for all plugin authoring needs.
export type {
  JsonSchema, PaperclipPluginManifestV1, PluginBridgeErrorCode, PluginCapability, PluginCategory, PluginConfig, PluginEventType, PluginJobDeclaration, PluginJobRunStatus,
  PluginJobRunTrigger, PluginJobStatus, PluginLauncherAction, PluginLauncherActionDeclaration, PluginLauncherBounds, PluginLauncherDeclaration, PluginLauncherPlacementZone, PluginLauncherRenderDeclaration, PluginLauncherRenderEnvironment, PluginMinimumHostVersion,
  PluginRecord, PluginStateScopeKind, PluginStatus, PluginToolDeclaration, PluginUiDeclaration, PluginUiSlotDeclaration, PluginUiSlotEntityType, PluginUiSlotType, PluginWebhookDeclaration, PluginWebhookDeliveryStatus
} from "./types.js";

// ---------------------------------------------------------------------------
// Zod re-export
// ---------------------------------------------------------------------------

/**
 * Zod is re-exported for plugin authors to use when defining their
 * `instanceConfigSchema` and tool `parametersSchema`.
 *
 * Plugin authors do not need to add a separate `zod` dependency.
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 *
 * @example
 * ```ts
 * import { z } from "@rudderhq/plugin-sdk";
 *
 * const configSchema = z.object({
 *   apiKey: z.string().describe("Your API key"),
 *   workspace: z.string().optional(),
 * });
 * ```
 */
export { z } from "zod";

// ---------------------------------------------------------------------------
// Constants re-exports (for plugin code that needs to check values at runtime)
// ---------------------------------------------------------------------------

export {
  PLUGIN_API_VERSION, PLUGIN_BRIDGE_ERROR_CODES, PLUGIN_CAPABILITIES, PLUGIN_CATEGORIES, PLUGIN_EVENT_TYPES, PLUGIN_JOB_RUN_STATUSES,
  PLUGIN_JOB_RUN_TRIGGERS, PLUGIN_JOB_STATUSES, PLUGIN_STATE_SCOPE_KINDS, PLUGIN_STATUSES, PLUGIN_UI_SLOT_ENTITY_TYPES, PLUGIN_UI_SLOT_TYPES, PLUGIN_WEBHOOK_DELIVERY_STATUSES
} from "@rudderhq/shared";
