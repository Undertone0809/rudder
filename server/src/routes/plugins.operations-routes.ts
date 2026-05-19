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

import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { organizations, pluginLogs, pluginWebhookDeliveries } from "@rudderhq/db";
import type {
  PluginStatus,
  PaperclipPluginManifestV1,
  PluginBridgeErrorCode,
  PluginLauncherRenderContextSnapshot,
} from "@rudderhq/shared";
import {
  PLUGIN_STATUSES,
} from "@rudderhq/shared";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { getPluginUiContributionMetadata, pluginLoader } from "../services/plugin-loader.js";
import { logActivity } from "../services/activity-log.js";
import { publishGlobalLiveEvent } from "../services/live-events.js";
import type { PluginJobScheduler } from "../services/plugin-job-scheduler.js";
import type { PluginJobStore } from "../services/plugin-job-store.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginStreamBus } from "../services/plugin-stream-bus.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { ToolRunContext } from "@rudderhq/plugin-sdk";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@rudderhq/plugin-sdk";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";

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

type PluginOperationsRouteContext = {
  router: Router;
  db: Db;
  [key: string]: any;
};

export function registerPluginOperationsRoutes(ctx: PluginOperationsRouteContext) {
  const {
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
  } = ctx;
  router.get("/plugins/:pluginId/logs", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 25, 1), 500);
    const level = req.query.level as string | undefined;
    const since = req.query.since as string | undefined;

    const conditions = [eq(pluginLogs.pluginId, plugin.id)];
    if (level) {
      conditions.push(eq(pluginLogs.level, level));
    }
    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        conditions.push(gte(pluginLogs.createdAt, sinceDate));
      }
    }

    const rows = await db
      .select()
      .from(pluginLogs)
      .where(and(...conditions))
      .orderBy(desc(pluginLogs.createdAt))
      .limit(limit);

    res.json(rows);
  });

  /**
   * POST /api/plugins/:pluginId/upgrade
   *
   * Upgrade a plugin to a newer version.
   *
   * Request body (optional):
   * - version: Target version (defaults to latest)
   *
   * If the upgrade adds new capabilities, the plugin transitions to
   * 'upgrade_pending' state for board approval. Otherwise, it goes
   * directly to 'ready'.
   *
   * Response: PluginRecord
   * Errors: 404 if plugin not found, 400 for lifecycle errors
   */
  router.post("/plugins/:pluginId/upgrade", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;
    const body = req.body as { version?: string } | undefined;
    const version = body?.version;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    try {
      // Upgrade the plugin - this would typically:
      // 1. Download the new version
      // 2. Compare capabilities
      // 3. If new capabilities, mark as upgrade_pending
      // 4. Otherwise, transition to ready
      const result = await lifecycle.upgrade(plugin.id, version);
      await logPluginMutationActivity(req, "plugin.upgraded", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        previousVersion: plugin.version,
        version: result?.version ?? plugin.version,
        targetVersion: version ?? null,
      });
      publishGlobalLiveEvent({ type: "plugin.ui.updated", payload: { pluginId: plugin.id, action: "upgraded" } });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Plugin configuration routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/config
   *
   * Retrieve the current instance configuration for a plugin.
   *
   * Returns the `PluginConfig` record if one exists, or `null` if the plugin
   * has not yet been configured.
   *
   * Response: `PluginConfig | null`
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const config = await registry.getConfig(plugin.id);
    res.json(config);
  });

  /**
   * POST /api/plugins/:pluginId/config
   *
   * Save (create or replace) the instance configuration for a plugin.
   *
   * The caller provides the full `configJson` object. The server persists it
   * via `registry.upsertConfig()`.
   *
   * Request body:
   * - `configJson`: Configuration values matching the plugin's `instanceConfigSchema`
   *
   * Response: `PluginConfig`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   */
  router.post("/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    // Strip devUiUrl unless the caller is an instance admin. devUiUrl activates
    // a dev-proxy in the static file route that could be abused for SSRF if any
    // board-level user were allowed to set it.
    if (
      "devUiUrl" in body.configJson &&
      !(req.actor.type === "board" && req.actor.isInstanceAdmin)
    ) {
      delete body.configJson.devUiUrl;
    }

    // Validate configJson against the plugin's instanceConfigSchema (if declared).
    // This ensures CLI/API callers get the same validation the UI performs client-side.
    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        res.status(400).json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        });
        return;
      }
    }

    try {
      const result = await registry.upsertConfig(plugin.id, {
        configJson: body.configJson,
      });
      await logPluginMutationActivity(req, "plugin.config.updated", plugin.id, {
        pluginId: plugin.id,
        pluginKey: plugin.pluginKey,
        configKeyCount: Object.keys(body.configJson).length,
      });

      // Notify the running worker about the config change (PLUGIN_SPEC §25.4.4).
      // If the worker implements onConfigChanged, send the new config via RPC.
      // If it doesn't (METHOD_NOT_IMPLEMENTED), restart the worker so it picks
      // up the new config on re-initialize. If no worker is running, skip.
      if (bridgeDeps?.workerManager.isRunning(plugin.id)) {
        try {
          await bridgeDeps.workerManager.call(
            plugin.id,
            "configChanged",
            { config: body.configJson },
          );
        } catch (rpcErr) {
          if (
            rpcErr instanceof JsonRpcCallError &&
            rpcErr.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
          ) {
            // Worker doesn't handle live config — restart it.
            try {
              await lifecycle.restartWorker(plugin.id);
            } catch {
              // Restart failure is non-fatal for the config save response.
            }
          }
          // Other RPC errors (timeout, unavailable) are non-fatal — config is
          // already persisted and will take effect on next worker restart.
        }
      }

      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/config/test
   *
   * Test a plugin configuration without persisting it by calling the plugin
   * worker's `validateConfig` RPC method.
   *
   * Only works when the plugin's worker implements `onValidateConfig`.
   * If the worker does not implement the method, returns
   * `{ valid: false, supported: false, message: "..." }` with HTTP 200.
   *
   * Request body:
   * - `configJson`: Configuration values to validate
   *
   * Response: `{ valid: boolean; message?: string; supported?: boolean }`
   * Errors:
   * - 400 if request validation fails
   * - 404 if plugin not found
   * - 501 if bridge deps (worker manager) are not configured
   * - 502 if the worker is unavailable
   */
  router.post("/plugins/:pluginId/config/test", async (req, res) => {
    assertBoard(req);

    if (!bridgeDeps) {
      res.status(501).json({ error: "Plugin bridge is not enabled" });
      return;
    }

    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    const body = req.body as { configJson?: Record<string, unknown> } | undefined;
    if (!body?.configJson || typeof body.configJson !== "object") {
      res.status(400).json({ error: '"configJson" is required and must be an object' });
      return;
    }

    // Fast schema-level rejection before hitting the worker RPC.
    const schema = plugin.manifestJson?.instanceConfigSchema;
    if (schema && Object.keys(schema).length > 0) {
      const validation = validateInstanceConfig(body.configJson, schema);
      if (!validation.valid) {
        res.status(400).json({
          error: "Configuration does not match the plugin's instanceConfigSchema",
          fieldErrors: validation.errors,
        });
        return;
      }
    }

    try {
      const result = await bridgeDeps.workerManager.call(
        plugin.id,
        "validateConfig",
        { config: body.configJson },
      );

      // The worker returns PluginConfigValidationResult { ok, warnings?, errors? }
      // Map to the frontend-expected shape { valid, message? }
      if (result.ok) {
        const warningText = result.warnings?.length
          ? `Warnings: ${result.warnings.join("; ")}`
          : undefined;
        res.json({ valid: true, message: warningText });
      } else {
        const errorText = result.errors?.length
          ? result.errors.join("; ")
          : "Configuration validation failed.";
        res.json({ valid: false, message: errorText });
      }
    } catch (err) {
      // If the worker does not implement validateConfig, return a structured response
      if (
        err instanceof JsonRpcCallError &&
        err.code === PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED
      ) {
        res.json({
          valid: false,
          supported: false,
          message: "This plugin does not support configuration testing.",
        });
        return;
      }

      // Worker unavailable or other RPC errors
      const bridgeError = mapRpcErrorToBridgeError(err);
      res.status(502).json(bridgeError);
    }
  });

  // ===========================================================================
  // Job scheduling routes
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/jobs
   *
   * List all scheduled jobs for a plugin.
   *
   * Query params:
   * - `status` (optional): Filter by job status (`active`, `paused`, `failed`)
   *
   * Response: PluginJobRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const rawStatus = req.query.status as string | undefined;
    const validStatuses = ["active", "paused", "failed"];
    if (rawStatus !== undefined && !validStatuses.includes(rawStatus)) {
      res.status(400).json({
        error: `Invalid status '${rawStatus}'. Must be one of: ${validStatuses.join(", ")}`,
      });
      return;
    }

    try {
      const jobs = await jobDeps.jobStore.listJobs(
        plugin.id,
        rawStatus as "active" | "paused" | "failed" | undefined,
      );
      res.json(jobs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * GET /api/plugins/:pluginId/jobs/:jobId/runs
   *
   * List execution history for a specific job.
   *
   * Query params:
   * - `limit` (optional): Maximum number of runs to return (default: 50)
   *
   * Response: PluginJobRunRecord[]
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/jobs/:jobId/runs", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 25;
    if (isNaN(limit) || limit < 1 || limit > 500) {
      res.status(400).json({ error: "limit must be a number between 1 and 500" });
      return;
    }

    try {
      const runs = await jobDeps.jobStore.listRunsByJob(jobId, limit);
      res.json(runs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/plugins/:pluginId/jobs/:jobId/trigger
   *
   * Manually trigger a job execution outside its cron schedule.
   *
   * Creates a run with `trigger: "manual"` and dispatches immediately.
   * The response returns before the job completes (non-blocking).
   *
   * Response: `{ runId: string, jobId: string }`
   * Errors:
   * - 404 if plugin not found
   * - 400 if job not found, not active, already running, or worker unavailable
   */
  router.post("/plugins/:pluginId/jobs/:jobId/trigger", async (req, res) => {
    assertBoard(req);
    if (!jobDeps) {
      res.status(501).json({ error: "Job scheduling is not enabled" });
      return;
    }

    const { pluginId, jobId } = req.params;
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    const job = await jobDeps.jobStore.getJobByIdForPlugin(plugin.id, jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    try {
      const result = await jobDeps.scheduler.triggerJob(jobId, "manual");
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // ===========================================================================
  // Webhook ingestion route
  // ===========================================================================

  /**
   * POST /api/plugins/:pluginId/webhooks/:endpointKey
   *
   * Receive an inbound webhook delivery for a plugin.
   *
   * This route is called by external systems (e.g. GitHub, Linear, Stripe) to
   * deliver webhook payloads to a plugin. The host validates that:
   * 1. The plugin exists and is in 'ready' state
   * 2. The plugin declares the `webhooks.receive` capability
   * 3. The `endpointKey` matches a declared webhook in the manifest
   *
   * The delivery is recorded in the `plugin_webhook_deliveries` table and
   * dispatched to the worker via the `handleWebhook` RPC method.
   *
   * **Note:** This route does NOT require board authentication — webhook
   * endpoints must be publicly accessible for external callers. Signature
   * verification is the plugin's responsibility.
   *
   * Response: `{ deliveryId: string, status: string }`
   * Errors:
   * - 404 if plugin not found or endpointKey not declared
   * - 400 if plugin is not in ready state or lacks webhooks.receive capability
   * - 502 if the worker is unavailable or the RPC call fails
   */
  router.post("/plugins/:pluginId/webhooks/:endpointKey", async (req, res) => {
    if (!webhookDeps) {
      res.status(501).json({ error: "Webhook ingestion is not enabled" });
      return;
    }

    const { pluginId, endpointKey } = req.params;

    // Step 1: Resolve the plugin
    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // Step 2: Validate the plugin is in 'ready' state
    if (plugin.status !== "ready") {
      res.status(400).json({
        error: `Plugin is not ready (current status: ${plugin.status})`,
      });
      return;
    }

    // Step 3: Validate the plugin has webhooks.receive capability
    const manifest = plugin.manifestJson;
    if (!manifest) {
      res.status(400).json({ error: "Plugin manifest is missing" });
      return;
    }

    const capabilities = manifest.capabilities ?? [];
    if (!capabilities.includes("webhooks.receive")) {
      res.status(400).json({
        error: "Plugin does not have the webhooks.receive capability",
      });
      return;
    }

    // Step 4: Validate the endpointKey exists in the manifest's webhook declarations
    const declaredWebhooks = manifest.webhooks ?? [];
    const webhookDecl = declaredWebhooks.find(
      (w: { endpointKey?: string }) => w.endpointKey === endpointKey,
    );
    if (!webhookDecl) {
      res.status(404).json({
        error: `Webhook endpoint '${endpointKey}' is not declared by this plugin`,
      });
      return;
    }

    // Step 5: Extract request data
    const requestId = randomUUID();
    const rawHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        rawHeaders[key] = value;
      } else if (Array.isArray(value)) {
        rawHeaders[key] = value.join(", ");
      }
    }

    // Use the raw buffer stashed by the express.json() `verify` callback.
    // This preserves the exact bytes the provider signed, whereas
    // JSON.stringify(req.body) would re-serialize and break HMAC verification.
    const stashedRaw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const rawBody = stashedRaw ? stashedRaw.toString("utf-8") : "";
    const parsedBody = req.body as unknown;
    const payload = (req.body as Record<string, unknown> | undefined) ?? {};

    // Step 6: Record the delivery in the database
    const startedAt = new Date();
    const [delivery] = await db
      .insert(pluginWebhookDeliveries)
      .values({
        pluginId: plugin.id,
        webhookKey: endpointKey,
        status: "pending",
        payload,
        headers: rawHeaders,
        startedAt,
      })
      .returning({ id: pluginWebhookDeliveries.id });

    // Step 7: Dispatch to the worker via handleWebhook RPC
    try {
      await webhookDeps.workerManager.call(plugin.id, "handleWebhook", {
        endpointKey,
        headers: req.headers as Record<string, string | string[]>,
        rawBody,
        parsedBody,
        requestId,
      });

      // Step 8: Update delivery record to success
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "success",
          durationMs,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(200).json({
        deliveryId: delivery.id,
        status: "success",
      });
    } catch (err) {
      // Step 8 (error): Update delivery record to failed
      const finishedAt = new Date();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const errorMessage = err instanceof Error ? err.message : String(err);

      await db
        .update(pluginWebhookDeliveries)
        .set({
          status: "failed",
          durationMs,
          error: errorMessage,
          finishedAt,
        })
        .where(eq(pluginWebhookDeliveries.id, delivery.id));

      res.status(502).json({
        deliveryId: delivery.id,
        status: "failed",
        error: errorMessage,
      });
    }
  });

  // ===========================================================================
  // Plugin health dashboard — aggregated diagnostics for the settings page
  // ===========================================================================

  /**
   * GET /api/plugins/:pluginId/dashboard
   *
   * Aggregated health dashboard data for a plugin's settings page.
   *
   * Returns worker diagnostics (status, uptime, crash history), recent job
   * runs, recent webhook deliveries, and the current health check result —
   * all in a single response to avoid multiple round-trips.
   *
   * Response: PluginDashboardData
   * Errors: 404 if plugin not found
   */
  router.get("/plugins/:pluginId/dashboard", async (req, res) => {
    assertBoard(req);
    const { pluginId } = req.params;

    const plugin = await resolvePlugin(registry, pluginId);
    if (!plugin) {
      res.status(404).json({ error: "Plugin not found" });
      return;
    }

    // --- Worker diagnostics ---
    let worker: {
      status: string;
      pid: number | null;
      uptime: number | null;
      consecutiveCrashes: number;
      totalCrashes: number;
      pendingRequests: number;
      lastCrashAt: number | null;
      nextRestartAt: number | null;
    } | null = null;

    // Try bridgeDeps first (primary source for worker manager), fallback to webhookDeps
    const wm = bridgeDeps?.workerManager ?? webhookDeps?.workerManager ?? null;
    if (wm) {
      const handle = wm.getWorker(plugin.id);
      if (handle) {
        const diag = handle.diagnostics();
        worker = {
          status: diag.status,
          pid: diag.pid,
          uptime: diag.uptime,
          consecutiveCrashes: diag.consecutiveCrashes,
          totalCrashes: diag.totalCrashes,
          pendingRequests: diag.pendingRequests,
          lastCrashAt: diag.lastCrashAt,
          nextRestartAt: diag.nextRestartAt,
        };
      }
    }

    // --- Recent job runs (last 10, newest first) ---
    let recentJobRuns: Array<{
      id: string;
      jobId: string;
      jobKey?: string;
      trigger: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    if (jobDeps) {
      try {
        const runs = await jobDeps.jobStore.listRunsByPlugin(plugin.id, undefined, 10);
        // Also fetch job definitions so we can include jobKey
        const jobs = await jobDeps.jobStore.listJobs(plugin.id);
        const jobKeyMap = new Map(jobs.map((j: any) => [j.id, j.jobKey]));

        recentJobRuns = runs
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .map((r: any) => ({
            id: r.id,
            jobId: r.jobId,
            jobKey: jobKeyMap.get(r.jobId) ?? undefined,
            trigger: r.trigger,
            status: r.status,
            durationMs: r.durationMs,
            error: r.error,
            startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
            finishedAt: r.finishedAt ? new Date(r.finishedAt).toISOString() : null,
            createdAt: new Date(r.createdAt).toISOString(),
          }));
      } catch {
        // Job data unavailable — leave empty
      }
    }

    // --- Recent webhook deliveries (last 10, newest first) ---
    let recentWebhookDeliveries: Array<{
      id: string;
      webhookKey: string;
      status: string;
      durationMs: number | null;
      error: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      createdAt: string;
    }> = [];

    try {
      const deliveries = await db
        .select({
          id: pluginWebhookDeliveries.id,
          webhookKey: pluginWebhookDeliveries.webhookKey,
          status: pluginWebhookDeliveries.status,
          durationMs: pluginWebhookDeliveries.durationMs,
          error: pluginWebhookDeliveries.error,
          startedAt: pluginWebhookDeliveries.startedAt,
          finishedAt: pluginWebhookDeliveries.finishedAt,
          createdAt: pluginWebhookDeliveries.createdAt,
        })
        .from(pluginWebhookDeliveries)
        .where(eq(pluginWebhookDeliveries.pluginId, plugin.id))
        .orderBy(desc(pluginWebhookDeliveries.createdAt))
        .limit(10);

      recentWebhookDeliveries = deliveries.map((d) => ({
        id: d.id,
        webhookKey: d.webhookKey,
        status: d.status,
        durationMs: d.durationMs,
        error: d.error,
        startedAt: d.startedAt ? d.startedAt.toISOString() : null,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      }));
    } catch {
      // Webhook data unavailable — leave empty
    }

    // --- Health check (same logic as GET /health) ---
    const checks: PluginHealthCheckResult["checks"] = [];

    checks.push({
      name: "registry",
      passed: true,
      message: "Plugin found in registry",
    });

    const hasValidManifest = Boolean(plugin.manifestJson?.id);
    checks.push({
      name: "manifest",
      passed: hasValidManifest,
      message: hasValidManifest ? "Manifest is valid" : "Manifest is invalid or missing",
    });

    const isHealthy = plugin.status === "ready";
    checks.push({
      name: "status",
      passed: isHealthy,
      message: `Current status: ${plugin.status}`,
    });

    const hasNoError = !plugin.lastError;
    if (!hasNoError) {
      checks.push({
        name: "error_state",
        passed: false,
        message: plugin.lastError ?? undefined,
      });
    }

    const health: PluginHealthCheckResult = {
      pluginId: plugin.id,
      status: plugin.status,
      healthy: isHealthy && hasValidManifest && hasNoError,
      checks,
      lastError: plugin.lastError ?? undefined,
    };

    res.json({
      pluginId: plugin.id,
      worker,
      recentJobRuns,
      recentWebhookDeliveries,
      health,
      checkedAt: new Date().toISOString(),
    });
  });
}
