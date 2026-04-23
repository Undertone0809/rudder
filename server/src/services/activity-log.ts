import { randomUUID } from "node:crypto";
import type { Db } from "@rudder/db";
import { activityLog } from "@rudder/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@rudder/shared";
import type { PluginEvent } from "@rudder/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { observeExecutionEvent } from "../langfuse.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const LANGFUSE_ACTIVITY_EXPORT_ALLOWLIST: ReadonlySet<string> = new Set();

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
}

function shouldExportActivityToLangfuse(
  input: LogActivityInput,
): input is LogActivityInput & { runId: string } {
  // Keep activity in Rudder's audit log by default. Exporting every mutation to Langfuse
  // creates low-signal traces that are detached from actual runtime/model execution.
  return typeof input.runId === "string"
    && input.runId.trim().length > 0
    && LANGFUSE_ACTIVITY_EXPORT_ALLOWLIST.has(input.action);
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  await db.insert(activityLog).values({
    orgId: input.orgId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
  });

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
      runId: input.runId ?? null,
      details: redactedDetails,
    },
  });

  if (shouldExportActivityToLangfuse(input)) {
    void observeExecutionEvent(
      {
        surface: "activity_mutation",
        rootExecutionId: input.runId,
        orgId: input.orgId,
        agentId: input.agentId ?? null,
        issueId: typeof redactedDetails?.issueId === "string" ? redactedDetails.issueId : null,
        status: input.action,
        metadata: {
          actorType: input.actorType,
          actorId: input.actorId,
          entityType: input.entityType,
          entityId: input.entityId,
        },
      },
      {
        name: `activity.${input.action}`,
        asType: "event",
        input: redactedDetails,
        metadata: {
          entityType: input.entityType,
          entityId: input.entityId,
        },
      },
    ).catch((error) => {
      logger.warn({ err: error instanceof Error ? error.message : String(error), runId: input.runId }, "Failed to emit Langfuse activity event");
    });
  }

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
        runId: input.runId ?? null,
      },
    };
    void _pluginEventBus.emit(event).then(({ errors }) => {
      for (const { pluginId, error } of errors) {
        logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
      }
    }).catch(() => {});
  }
}
