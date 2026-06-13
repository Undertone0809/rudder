/**
 * `@rudderhq/plugin-sdk/ui` — Rudder plugin UI SDK.
 *
 * Import this subpath from plugin UI bundles (React components that run in
 * the host frontend).  Do **not** import this from plugin worker code.
 *
 * The worker-side SDK is available from `@rudderhq/plugin-sdk` (root).
 *
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 *
 * @example
 * ```tsx
 * // Plugin UI bundle entry (dist/ui/index.tsx)
 * import { usePluginData, usePluginAction } from "@rudderhq/plugin-sdk/ui";
 * import type { PluginWidgetProps } from "@rudderhq/plugin-sdk/ui";
 *
 * export function DashboardWidget({ context }: PluginWidgetProps) {
 *   const { data, loading, error } = usePluginData("sync-health", {
 *     orgId: context.orgId,
 *   });
 *   const resync = usePluginAction("resync");
 *
 *   if (loading) return <div>Loading…</div>;
 *   if (error) return <div>Error: {error.message}</div>;
 *
 *   return (
 *     <div style={{ display: "grid", gap: 8 }}>
 *       <strong>Synced Issues</strong>
 *       <div>{data!.syncedCount}</div>
 *       <button onClick={() => resync({ orgId: context.orgId })}>
 *         Resync Now
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

/**
 * Bridge hooks for plugin UI components to communicate with the plugin worker.
 *
 * - `usePluginData(key, params)` — fetch data from the worker's `getData` handler
 * - `usePluginAction(key)` — get a callable that invokes the worker's `performAction` handler
 * - `useHostContext()` — read the current active company, project, entity, and user IDs
 * - `usePluginStream(channel)` — subscribe to real-time SSE events from the worker
 */
export {
  useHostContext, usePluginAction, usePluginData, usePluginStream,
  usePluginToast
} from "./hooks.js";

// Bridge error and host context types
export type {
  PluginActionFn, PluginBridgeError,
  PluginBridgeErrorCode, PluginDataResult, PluginHostContext, PluginLauncherBounds,
  PluginLauncherRenderEnvironment, PluginModalBoundsRequest,
  PluginRenderCloseEvent,
  PluginRenderCloseHandler,
  PluginRenderCloseLifecycle,
  PluginRenderEnvironmentContext, PluginStreamResult, PluginToastAction, PluginToastFn, PluginToastInput, PluginToastTone
} from "./types.js";

// Slot component prop interfaces
export type {
  PluginCommentAnnotationProps,
  PluginCommentContextMenuItemProps, PluginDetailTabProps, PluginPageProps, PluginProjectSidebarItemProps, PluginSettingsPageProps, PluginSidebarProps, PluginWidgetProps
} from "./types.js";
