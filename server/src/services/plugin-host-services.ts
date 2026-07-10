import type { Db } from "@rudderhq/db";
import { agentTaskSessions as agentTaskSessionsTable, pluginLogs } from "@rudderhq/db";
import type {
  Agent,
  Goal,
  HostServices,
  Issue,
  IssueComment,
  Organization,
  Project
} from "@rudderhq/plugin-sdk";
import { and, desc, eq, like } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { activityService } from "./activity.js";
import { agentService } from "./agents.js";
import { assetService } from "./assets.js";
import { costService } from "./costs.js";
import { goalService } from "./goals.js";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { organizationService } from "./orgs.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { createPluginSecretsHandler } from "./plugin-secrets-handler.js";
import { pluginStateStore } from "./plugin-state-store.js";
import { projectService } from "./projects.js";
import {
  fetchPublicHttpUrlOnce,
  type WebsiteMetadataOptions,
} from "./website-metadata.js";

// ---------------------------------------------------------------------------
// SSRF and resource controls for plugin HTTP fetch
// ---------------------------------------------------------------------------

const PLUGIN_FETCH_TIMEOUT_MS = 30_000;
const PLUGIN_FETCH_MAX_REDIRECTS = 5;
const DEFAULT_PLUGIN_FETCH_REQUEST_BYTES = 1024 * 1024;
const HARD_MAX_PLUGIN_FETCH_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_PLUGIN_FETCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const HARD_MAX_PLUGIN_FETCH_RESPONSE_BYTES = 32 * 1024 * 1024;

export type PluginHttpFetchOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  publicHttpOptions?: WebsiteMetadataOptions;
};

function boundedPluginFetchInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function pluginRequestBody(body: RequestInit["body"]) {
  if (body === undefined || body === null) return undefined;
  return typeof body === "string" ? body : String(body);
}

function pluginFetchHeaders(response: Response) {
  return Object.fromEntries(response.headers.entries());
}

async function cancelPluginFetchResponse(response: Response, reason?: unknown) {
  await response.body?.cancel(reason).catch(() => undefined);
}

async function racePluginFetchSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Plugin HTTP request aborted");
  let rejectOnAbort: ((reason?: unknown) => void) | null = null;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort?.(signal.reason ?? new Error("Plugin HTTP request aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedPluginFetchBody(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelPluginFetchResponse(response, new Error("Plugin HTTP response exceeds size limit"));
    throw new Error(`Plugin HTTP response body exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        chunks.length = 0;
        await reader.cancel(new Error("Plugin HTTP response exceeds size limit"));
        throw new Error(`Plugin HTTP response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    chunks.length = 0;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function stripCrossOriginSensitiveHeaders(headers: Headers) {
  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    headers.delete(name);
  }
}

export async function fetchPluginHttp(
  params: { url: string; init?: RequestInit },
  options: PluginHttpFetchOptions = {},
): Promise<{ status: number; statusText: string; headers: Record<string, string>; body: string }> {
  const maxRequestBytes = boundedPluginFetchInteger(
    options.maxRequestBytes ?? process.env.RUDDER_PLUGIN_HTTP_MAX_REQUEST_BYTES,
    DEFAULT_PLUGIN_FETCH_REQUEST_BYTES,
    1,
    HARD_MAX_PLUGIN_FETCH_REQUEST_BYTES,
  );
  const maxResponseBytes = boundedPluginFetchInteger(
    options.maxResponseBytes ?? process.env.RUDDER_PLUGIN_HTTP_MAX_RESPONSE_BYTES,
    DEFAULT_PLUGIN_FETCH_RESPONSE_BYTES,
    1,
    HARD_MAX_PLUGIN_FETCH_RESPONSE_BYTES,
  );
  const maxRedirects = boundedPluginFetchInteger(
    options.maxRedirects,
    PLUGIN_FETCH_MAX_REDIRECTS,
    0,
    10,
  );
  const timeoutMs = boundedPluginFetchInteger(
    options.timeoutMs,
    PLUGIN_FETCH_TIMEOUT_MS,
    1,
    PLUGIN_FETCH_TIMEOUT_MS,
  );
  let requestBody = pluginRequestBody(params.init?.body);
  if (requestBody !== undefined && Buffer.byteLength(requestBody) > maxRequestBytes) {
    throw new Error(`Plugin HTTP request body exceeded ${maxRequestBytes} bytes`);
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = params.init?.signal
    ? AbortSignal.any([params.init.signal, timeoutSignal])
    : timeoutSignal;
  let currentUrl = new URL(params.url);
  let method = params.init?.method ?? "GET";
  let headers = new Headers(params.init?.headers);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (requestBody !== undefined && !headers.has("content-length") && !headers.has("transfer-encoding")) {
      headers.set("content-length", String(Buffer.byteLength(requestBody)));
    }
    const fetched = await racePluginFetchSignal(
      fetchPublicHttpUrlOnce(
        currentUrl,
        options.publicHttpOptions,
        {
          method,
          headers,
          body: requestBody,
          signal,
          redirect: "manual",
        },
      ),
      signal,
    );
    const { response } = fetched;
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelPluginFetchResponse(response);
      if (!location) {
        return {
          status: response.status,
          statusText: response.statusText,
          headers: pluginFetchHeaders(response),
          body: "",
        };
      }
      if (redirectCount === maxRedirects) {
        throw new Error("Plugin HTTP redirect limit exceeded");
      }

      const nextUrl = new URL(location, fetched.url);
      if (nextUrl.origin !== fetched.url.origin) {
        headers = new Headers(headers);
        stripCrossOriginSensitiveHeaders(headers);
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = "GET";
        requestBody = undefined;
        headers.delete("content-length");
        headers.delete("content-type");
        headers.delete("transfer-encoding");
      }
      currentUrl = nextUrl;
      continue;
    }

    const body = await racePluginFetchSignal(
      readBoundedPluginFetchBody(response, maxResponseBytes),
      signal,
    );
    return {
      status: response.status,
      statusText: response.statusText,
      headers: pluginFetchHeaders(response),
      body,
    };
  }

  throw new Error("Plugin HTTP redirect limit exceeded");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PATH_LIKE_PATTERN = /[\\/]/;
const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function looksLikePath(value: string): boolean {
  const normalized = value.trim();
  return (
    PATH_LIKE_PATTERN.test(normalized)
    || WINDOWS_DRIVE_PATH_PATTERN.test(normalized)
  ) && !UUID_PATTERN.test(normalized);
}

function sanitizeWorkspaceText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || UUID_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function sanitizeWorkspacePath(cwd: string | null): string {
  if (!cwd) return "";
  return looksLikePath(cwd) ? cwd.trim() : "";
}

function sanitizeWorkspaceName(name: string, fallbackPath: string): string {
  const safeName = sanitizeWorkspaceText(name);
  if (safeName && !looksLikePath(safeName)) {
    return safeName;
  }
  const normalized = fallbackPath.trim().replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "Workspace";
}

// ---------------------------------------------------------------------------
// Buffered plugin log writes
// ---------------------------------------------------------------------------

/** How many buffered log entries trigger an immediate flush. */
const LOG_BUFFER_FLUSH_SIZE = 100;

/** How often (ms) the buffer is flushed regardless of size. */
const LOG_BUFFER_FLUSH_INTERVAL_MS = 5_000;

/** Max length for a single plugin log message (bytes/chars). */
const MAX_LOG_MESSAGE_LENGTH = 10_000;

/** Max serialised JSON size for plugin log meta objects. */
const MAX_LOG_META_JSON_LENGTH = 50_000;

/** Max length for a metric name. */
const MAX_METRIC_NAME_LENGTH = 500;

/** Pino reserved field names that plugins must not overwrite. */
const PINO_RESERVED_KEYS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "v",
]);

/** Truncate a string to `max` characters, appending a marker if truncated. */
function truncStr(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...[truncated]";
}

/** Sanitise a plugin-supplied meta object: enforce size limit and strip reserved keys. */
function sanitiseMeta(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (meta == null) return null;
  // Strip pino reserved keys
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!PINO_RESERVED_KEYS.has(k)) {
      cleaned[k] = v;
    }
  }
  // Enforce total serialised size
  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return { _sanitised: true, _error: "meta was not JSON-serialisable" };
  }
  if (json.length > MAX_LOG_META_JSON_LENGTH) {
    return { _sanitised: true, _error: `meta exceeded ${MAX_LOG_META_JSON_LENGTH} chars` };
  }
  return cleaned;
}

interface BufferedLogEntry {
  db: Db;
  pluginId: string;
  level: string;
  message: string;
  meta: Record<string, unknown> | null;
}

const _logBuffer: BufferedLogEntry[] = [];

/**
 * Flush all buffered log entries to the database in a single batch insert per
 * unique db instance. Errors are swallowed with a console.error fallback so
 * flushing never crashes the process.
 */
export async function flushPluginLogBuffer(): Promise<void> {
  if (_logBuffer.length === 0) return;

  // Drain the buffer atomically so concurrent flushes don't double-insert.
  const entries = _logBuffer.splice(0, _logBuffer.length);

  // Group entries by db identity so multi-db scenarios are handled correctly.
  const byDb = new Map<Db, BufferedLogEntry[]>();
  for (const entry of entries) {
    const group = byDb.get(entry.db);
    if (group) {
      group.push(entry);
    } else {
      byDb.set(entry.db, [entry]);
    }
  }

  for (const [dbInstance, group] of byDb) {
    const values = group.map((e) => ({
      pluginId: e.pluginId,
      level: e.level,
      message: e.message,
      meta: e.meta,
    }));
    try {
      await dbInstance.insert(pluginLogs).values(values);
    } catch (err) {
      try {
        logger.warn({ err, count: values.length }, "Failed to batch-persist plugin logs to DB");
      } catch {
        console.error("[plugin-host-services] Batch log flush failed:", err);
      }
    }
  }
}

/** Interval handle for the periodic log flush. */
const _logFlushInterval = setInterval(() => {
  flushPluginLogBuffer().catch((err) => {
    console.error("[plugin-host-services] Periodic log flush error:", err);
  });
}, LOG_BUFFER_FLUSH_INTERVAL_MS);

// Allow the interval to be unref'd so it doesn't keep the process alive in tests.
if (_logFlushInterval.unref) _logFlushInterval.unref();

/**
 * buildHostServices — creates a concrete implementation of the `HostServices`
 * interface for a specific plugin.
 *
 * This implementation delegates to the core Rudder domain services,
 * providing the bridge between the plugin worker's SDK and the host platform.
 *
 * @param db - Database connection instance.
 * @param pluginId - The UUID of the plugin installation record.
 * @param pluginKey - The unique identifier from the plugin manifest (e.g., "acme.linear").
 * @param eventBus - The system-wide event bus for publishing plugin events.
 * @returns An object implementing the HostServices interface for the plugin SDK.
 */
/** Maximum time (ms) to keep a session event subscription alive before forcing cleanup. */
const SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes

export function buildHostServices(
  db: Db,
  pluginId: string,
  pluginKey: string,
  eventBus: PluginEventBus,
  notifyWorker?: (method: string, params: unknown) => void,
): HostServices & { dispose(): void } {
  const registry = pluginRegistryService(db);
  const stateStore = pluginStateStore(db);
  const secretsHandler = createPluginSecretsHandler({ db, pluginId });
  const organizations = organizationService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const goals = goalService(db);
  const activity = activityService(db);
  const costs = costService(db);
  const assets = assetService(db);
  const scopedBus = eventBus.forPlugin(pluginKey);

  // Track active session event subscriptions for cleanup
  const activeSubscriptions = new Set<{ unsubscribe: () => void; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  const ensureCompanyId = (orgId?: string) => {
    if (!orgId) throw new Error("orgId is required for this operation");
    return orgId;
  };

  const parseWindowValue = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return Math.max(0, Math.floor(parsed));
      }
    }
    return null;
  };

  const applyWindow = <T>(rows: T[], params?: { limit?: unknown; offset?: unknown }): T[] => {
    const offset = parseWindowValue(params?.offset) ?? 0;
    const limit = parseWindowValue(params?.limit);
    if (limit == null) return rows.slice(offset);
    return rows.slice(offset, offset + limit);
  };

  /**
   * Plugins are instance-wide in the current runtime. Organization IDs are still
   * required for organization-scoped data access, but there is no per-organization
   * availability gate to enforce here.
   */
  const ensurePluginAvailableForOrganization = async (_orgId: string) => {};

  const inOrganization = <T extends { orgId: string | null | undefined }>(
    record: T | null | undefined,
    orgId: string,
  ): record is T => Boolean(record && record.orgId === orgId);

  const requireInOrganization = <T extends { orgId: string | null | undefined }>(
    entityName: string,
    record: T | null | undefined,
    orgId: string,
  ): T => {
    if (!inOrganization(record, orgId)) {
      throw new Error(`${entityName} not found`);
    }
    return record;
  };

  return {
    config: {
      async get() {
        const configRow = await registry.getConfig(pluginId);
        return configRow?.configJson ?? {};
      },
    },

    state: {
      async get(params) {
        return stateStore.get(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
      async set(params) {
        await stateStore.set(pluginId, {
          scopeKind: params.scopeKind as any,
          scopeId: params.scopeId,
          namespace: params.namespace,
          stateKey: params.stateKey,
          value: params.value,
        });
      },
      async delete(params) {
        await stateStore.delete(pluginId, params.scopeKind as any, params.stateKey, {
          scopeId: params.scopeId,
          namespace: params.namespace,
        });
      },
    },

    entities: {
      async upsert(params) {
        return registry.upsertEntity(pluginId, params as any) as any;
      },
      async list(params) {
        return registry.listEntities(pluginId, params as any) as any;
      },
    },

    events: {
      async emit(params) {
        if (params.orgId) {
          await ensurePluginAvailableForOrganization(params.orgId);
        }
        await scopedBus.emit(params.name, params.orgId, params.payload);
      },
      async subscribe(params: { eventPattern: string; filter?: Record<string, unknown> | null }) {
        const handler = async (event: import("@rudderhq/plugin-sdk").PluginEvent) => {
          if (notifyWorker) {
            notifyWorker("onEvent", { event });
          }
        };
        if (params.filter) {
          scopedBus.subscribe(params.eventPattern as any, params.filter as any, handler);
        } else {
          scopedBus.subscribe(params.eventPattern as any, handler);
        }
      },
    },

    http: {
      async fetch(params) {
        return fetchPluginHttp({
          url: params.url,
          init: params.init as RequestInit | undefined,
        });
      },
    },

    secrets: {
      async resolve(params) {
        return secretsHandler.resolve(params);
      },
    },

    activity: {
      async log(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        await logActivity(db, {
          orgId,
          actorType: "system",
          actorId: pluginId,
          action: params.message,
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: params.metadata,
        });
      },
    },

    metrics: {
      async write(params) {
        const safeName = truncStr(String(params.name ?? ""), MAX_METRIC_NAME_LENGTH);
        logger.debug({ pluginId, name: safeName, value: params.value, tags: params.tags }, "Plugin metric write");

        // Persist metrics to plugin_logs via the batch buffer (same path as
        // logger.log) so they benefit from batched writes and are flushed
        // reliably on shutdown. Using level "metric" makes them queryable
        // alongside regular logs via the same API (§26).
        _logBuffer.push({
          db,
          pluginId,
          level: "metric",
          message: safeName,
          meta: sanitiseMeta({ value: params.value, tags: params.tags ?? null }),
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error("[plugin-host-services] Triggered metric flush failed:", err);
          });
        }
      },
    },

    logger: {
      async log(params) {
        const { level, meta } = params;
        const safeMessage = truncStr(String(params.message ?? ""), MAX_LOG_MESSAGE_LENGTH);
        const safeMeta = sanitiseMeta(meta);
        const pluginLogger = logger.child({ service: "plugin-worker", pluginId });
        const logFields = {
          ...safeMeta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error") pluginLogger.error(logFields, `[plugin] ${safeMessage}`);
        else if (level === "warn") pluginLogger.warn(logFields, `[plugin] ${safeMessage}`);
        else if (level === "debug") pluginLogger.debug(logFields, `[plugin] ${safeMessage}`);
        else pluginLogger.info(logFields, `[plugin] ${safeMessage}`);

        // Persist to plugin_logs table via the module-level batch buffer (§26.1).
        // Fire-and-forget — logging should never block the worker.
        _logBuffer.push({
          db,
          pluginId,
          level: level ?? "info",
          message: safeMessage,
          meta: safeMeta,
        });
        if (_logBuffer.length >= LOG_BUFFER_FLUSH_SIZE) {
          flushPluginLogBuffer().catch((err) => {
            console.error("[plugin-host-services] Triggered log flush failed:", err);
          });
        }
      },
    },

    organizations: {
      async list(params) {
        return applyWindow((await organizations.list()) as Organization[], params);
      },
      async get(params) {
        await ensurePluginAvailableForOrganization(params.orgId);
        return (await organizations.getById(params.orgId)) as Organization;
      },
    },

    projects: {
      async list(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        return applyWindow((await projects.list(orgId)) as Project[], params);
      },
      async get(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const project = await projects.getById(params.projectId);
        return (inOrganization(project, orgId) ? project : null) as Project | null;
      },
      async listWorkspaces(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const project = await projects.getById(params.projectId);
        if (!inOrganization(project, orgId)) return [];
        const rows = await projects.listWorkspaces(params.projectId);
        return rows.map((row) => {
          const path = sanitizeWorkspacePath(row.cwd);
          const name = sanitizeWorkspaceName(row.name, path);
          return {
            id: row.id,
            projectId: row.projectId,
            name,
            path,
            isPrimary: row.isPrimary,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        });
      },
      async getPrimaryWorkspace(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const project = await projects.getById(params.projectId);
        if (!inOrganization(project, orgId)) return null;
        if (!project.codebase.configured) return null;
        const row = project.primaryWorkspace;
        const path = sanitizeWorkspacePath(project.codebase.effectiveLocalFolder);
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `org:${project.orgId}:workspace`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },

      async getWorkspaceForIssue(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const issue = await issues.getById(params.issueId);
        if (!inOrganization(issue, orgId)) return null;
        const projectId = (issue as Record<string, unknown>).projectId as string | null;
        if (!projectId) return null;
        const project = await projects.getById(projectId);
        if (!inOrganization(project, orgId)) return null;
        if (!project.codebase.configured) return null;
        const row = project.primaryWorkspace;
        const path = sanitizeWorkspacePath(project.codebase.effectiveLocalFolder);
        const name = sanitizeWorkspaceName(row?.name ?? project.name, path);
        return {
          id: row?.id ?? `org:${project.orgId}:workspace`,
          projectId: project.id,
          name,
          path,
          isPrimary: true,
          createdAt: (row?.createdAt ?? project.createdAt).toISOString(),
          updatedAt: (row?.updatedAt ?? project.updatedAt).toISOString(),
        };
      },
    },

    issues: {
      async list(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        return applyWindow((await issues.list(orgId, params as any)) as Issue[], params);
      },
      async get(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const issue = await issues.getById(params.issueId);
        return (inOrganization(issue, orgId) ? issue : null) as Issue | null;
      },
      async create(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        return (await issues.create(orgId, params as any)) as Issue;
      },
      async update(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        requireInOrganization("Issue", await issues.getById(params.issueId), orgId);
        return (await issues.update(params.issueId, params.patch as any)) as Issue;
      },
      async listComments(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        if (!inOrganization(await issues.getById(params.issueId), orgId)) return [];
        return (await issues.listComments(params.issueId)) as IssueComment[];
      },
      async createComment(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        requireInOrganization("Issue", await issues.getById(params.issueId), orgId);
        return (await issues.addComment(
          params.issueId,
          params.body,
          {},
        )) as IssueComment;
      },
    },

    agents: {
      async list(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const rows = await agents.list(orgId);
        return applyWindow(
          rows.filter((agent) => !params.status || agent.status === params.status) as Agent[],
          params,
        );
      },
      async get(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const agent = await agents.getById(params.agentId);
        return (inOrganization(agent, orgId) ? agent : null) as Agent | null;
      },
      async pause(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const agent = await agents.getById(params.agentId);
        requireInOrganization("Agent", agent, orgId);
        return (await agents.pause(params.agentId)) as Agent;
      },
      async resume(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const agent = await agents.getById(params.agentId);
        requireInOrganization("Agent", agent, orgId);
        return (await agents.resume(params.agentId)) as Agent;
      },
      async invoke(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const agent = await agents.getById(params.agentId);
        requireInOrganization("Agent", agent, orgId);
        const run = await heartbeat.wakeup(params.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");
        return { runId: run.id };
      },
    },

    goals: {
      async list(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const rows = await goals.list(orgId);
        return applyWindow(
          rows.filter((goal) =>
            (!params.level || goal.level === params.level) &&
            (!params.status || goal.status === params.status),
          ) as Goal[],
          params,
        );
      },
      async get(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const goal = await goals.getById(params.goalId);
        return (inOrganization(goal, orgId) ? goal : null) as Goal | null;
      },
      async create(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        return (await goals.create(orgId, {
          title: params.title,
          description: params.description,
          level: params.level as any,
          status: params.status as any,
          parentId: params.parentId,
          ownerAgentId: params.ownerAgentId,
        })) as Goal;
      },
      async update(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        requireInOrganization("Goal", await goals.getById(params.goalId), orgId);
        return (await goals.update(params.goalId, params.patch as any)) as Goal;
      },
    },

    agentSessions: {
      async create(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const agent = await agents.getById(params.agentId);
        requireInOrganization("Agent", agent, orgId);
        const taskKey = params.taskKey ?? `plugin:${pluginKey}:session:${randomUUID()}`;

        const row = await db
          .insert(agentTaskSessionsTable)
          .values({
            orgId,
            agentId: params.agentId,
            agentRuntimeType: agent!.agentRuntimeType,
            taskKey,
            sessionParamsJson: null,
            sessionDisplayId: null,
            lastRunId: null,
            lastError: null,
          })
          .returning()
          .then((rows) => rows[0]);

        return {
          sessionId: row!.id,
          agentId: params.agentId,
          orgId,
          status: "active" as const,
          createdAt: row!.createdAt.toISOString(),
        };
      },

      async list(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const rows = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.agentId, params.agentId),
              eq(agentTaskSessionsTable.orgId, orgId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .orderBy(desc(agentTaskSessionsTable.createdAt));

        return rows.map((row) => ({
          sessionId: row.id,
          agentId: row.agentId,
          orgId: row.orgId,
          status: "active" as const,
          createdAt: row.createdAt.toISOString(),
        }));
      },

      async sendMessage(params) {
        if (disposed) {
          throw new Error("Host services have been disposed");
        }

        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);

        // Verify session exists and belongs to this plugin
        const session = await db
          .select()
          .from(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.orgId, orgId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!session) throw new Error(`Session not found: ${params.sessionId}`);

        const run = await heartbeat.wakeup(session.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: params.reason ?? null,
          payload: { prompt: params.prompt },
          contextSnapshot: {
            taskKey: session.taskKey,
            wakeSource: "automation",
            wakeTriggerDetail: "system",
          },
          requestedByActorType: "system",
          requestedByActorId: pluginId,
        });
        if (!run) throw new Error("Agent wakeup was skipped by heartbeat policy");

        // Subscribe to live events and forward to the plugin worker as notifications.
        // Track the subscription so it can be cleaned up on dispose() if the run
        // never reaches a terminal status (hang, crash, network partition).
        if (notifyWorker) {
          const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

          const cleanup = () => {
            unsubscribe();
            clearTimeout(timeoutTimer);
            activeSubscriptions.delete(entry);
          };

          const unsubscribe = subscribeCompanyLiveEvents(orgId, (event) => {
            const payload = event.payload as Record<string, unknown> | undefined;
            if (!payload || payload.runId !== run.id) return;

            if (event.type === "heartbeat.run.log" || event.type === "heartbeat.run.event") {
              notifyWorker("agents.sessions.event", {
                sessionId: params.sessionId,
                runId: run.id,
                seq: (payload.seq as number) ?? 0,
                eventType: "chunk",
                stream: (payload.stream as string) ?? null,
                message: (payload.chunk as string) ?? (payload.message as string) ?? null,
                payload: payload,
              });
            } else if (event.type === "heartbeat.run.status") {
              const status = payload.status as string;
              if (TERMINAL_STATUSES.has(status)) {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: status === "succeeded" ? "done" : "error",
                  stream: "system",
                  message: status === "succeeded" ? "Run completed" : `Run ${status}`,
                  payload: payload,
                });
                cleanup();
              } else {
                notifyWorker("agents.sessions.event", {
                  sessionId: params.sessionId,
                  runId: run.id,
                  seq: 0,
                  eventType: "status",
                  stream: "system",
                  message: `Run status: ${status}`,
                  payload: payload,
                });
              }
            }
          });

          // Safety-net timeout: if the run never reaches a terminal status,
          // force-cleanup the subscription to prevent unbounded leaks.
          const timeoutTimer = setTimeout(() => {
            logger.warn(
              { pluginId, pluginKey, runId: run.id },
              "session event subscription timed out — forcing cleanup",
            );
            cleanup();
          }, SESSION_EVENT_SUBSCRIPTION_TIMEOUT_MS);

          const entry = { unsubscribe, timer: timeoutTimer };
          activeSubscriptions.add(entry);
        }

        return { runId: run.id };
      },

      async close(params) {
        const orgId = ensureCompanyId(params.orgId);
        await ensurePluginAvailableForOrganization(orgId);
        const deleted = await db
          .delete(agentTaskSessionsTable)
          .where(
            and(
              eq(agentTaskSessionsTable.id, params.sessionId),
              eq(agentTaskSessionsTable.orgId, orgId),
              like(agentTaskSessionsTable.taskKey, `plugin:${pluginKey}:session:%`),
            ),
          )
          .returning()
          .then((rows) => rows.length);
        if (deleted === 0) throw new Error(`Session not found: ${params.sessionId}`);
      },
    },

    /**
     * Clean up all active session event subscriptions and flush any buffered
     * log entries. Must be called when the plugin worker is stopped, crashed,
     * or unloaded to prevent leaked listeners and lost log entries.
     */
    dispose() {
      disposed = true;

      // Clear event bus subscriptions to prevent accumulation on worker restart.
      // Without this, each crash/restart cycle adds duplicate subscriptions.
      scopedBus.clear();

      // Snapshot to avoid iterator invalidation from concurrent sendMessage() calls
      const snapshot = Array.from(activeSubscriptions);
      activeSubscriptions.clear();

      for (const entry of snapshot) {
        clearTimeout(entry.timer);
        entry.unsubscribe();
      }

      // Flush any buffered log entries synchronously-as-possible on dispose.
      flushPluginLogBuffer().catch((err) => {
        console.error("[plugin-host-services] dispose() log flush failed:", err);
      });
    },
  };
}
