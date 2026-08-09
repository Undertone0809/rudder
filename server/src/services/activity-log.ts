import type { Db } from "@rudderhq/db";
import { activityLog } from "@rudderhq/db";
import type { PluginEvent } from "@rudderhq/plugin-sdk";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import { redactCurrentUserValue } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { sanitizeRecord } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { publishLiveEvent } from "./live-events.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { isPostgresError } from "./postgres-errors.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVITY_RUN_ID_FK_CONSTRAINT = "activity_log_run_id_heartbeat_runs_id_fk";
const ACTIVITY_LOG_TRANSIENT_RETRIES = 2;

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

export interface LogActivityInput {
  orgId: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

function normalizeHeartbeatRunId(runId: string | null | undefined): string | null {
  if (typeof runId !== "string") return null;
  const trimmed = runId.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function isActivityRunIdPersistenceError(error: unknown): boolean {
  return isPostgresError(error, "23503", ACTIVITY_RUN_ID_FK_CONSTRAINT);
}

function isActivityLogTransientError(error: unknown): boolean {
  return isPostgresError(error, "40P01") || isPostgresError(error, "40001");
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  let persistedRunId = normalizeHeartbeatRunId(input.runId);
  const insertActivity = async () => {
    return db.insert(activityLog).values({
      orgId: input.orgId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: persistedRunId,
      details: redactedDetails,
      idempotencyKey: input.idempotencyKey ?? null,
    })
      .onConflictDoNothing()
      .returning({ id: activityLog.id })
      .then((rows) => rows[0] ?? null);
  };

  let inserted: { id: string } | null = null;
  for (let attempt = 0; attempt <= ACTIVITY_LOG_TRANSIENT_RETRIES; attempt += 1) {
    try {
      inserted = await insertActivity();
      break;
    } catch (error) {
      if (persistedRunId && isActivityRunIdPersistenceError(error)) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), runId: persistedRunId, action: input.action },
          "Activity run id did not match a heartbeat run; logging activity without run linkage",
        );
        persistedRunId = null;
        continue;
      }
      if (!isActivityLogTransientError(error) || attempt === ACTIVITY_LOG_TRANSIENT_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  if (!inserted) return null;

  publishLiveEvent({
    orgId: input.orgId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: persistedRunId,
      details: redactedDetails,
    },
  });

  if (_pluginEventBus && PLUGIN_EVENT_SET.has(input.action)) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: input.action as PluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      orgId: input.orgId,
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId: persistedRunId,
      },
    };
    void _pluginEventBus.emit(event).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
      }
    }).catch(() => {});
  }
  return inserted;
}
