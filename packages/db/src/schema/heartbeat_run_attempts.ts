import type {
  HeartbeatRunAttemptResumeSource,
  HeartbeatRunAttemptStatus,
  NativeChatProtocolPhase,
} from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";

/**
 * One durable row per runtime/model attempt. Rows are append-only: recovery
 * creates another attempt and never overwrites an earlier attempt's evidence.
 */
export const heartbeatRunAttempts = pgTable(
  "heartbeat_run_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    attemptIndex: integer("attempt_index").notNull(),
    fallbackIndex: integer("fallback_index"),
    runtimeType: text("runtime_type").notNull(),
    model: text("model"),
    isFallback: boolean("is_fallback").notNull().default(false),
    resumeSource: text("resume_source").$type<HeartbeatRunAttemptResumeSource>().notNull().default("fresh"),
    status: text("status").$type<HeartbeatRunAttemptStatus>().notNull().default("started"),
    /** Owner identity captured by the worker that admitted this attempt. */
    ownerToken: text("owner_token"),
    attemptEpoch: integer("attempt_epoch"),
    /** Independent generation and provider-connection fences for native Chat. */
    generationAttemptEpoch: integer("generation_attempt_epoch"),
    connectionEpoch: integer("connection_epoch"),
    /** Indexed mirror of checkpoint_json.phase for native Chat protocol ordering. */
    protocolPhase: text("protocol_phase").$type<NativeChatProtocolPhase | null>(),
    submissionPhase: text("submission_phase").$type<"pre_submission" | "accepted" | "indeterminate">(),
    providerThreadId: text("provider_thread_id"),
    providerTurnId: text("provider_turn_id"),
    sessionDisplayId: text("session_display_id"),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    checkpointJson: jsonb("checkpoint_json").$type<Record<string, unknown>>(),
    usageDeltaJson: jsonb("usage_delta_json").$type<Record<string, unknown>>(),
    costCents: integer("cost_cents"),
    errorCode: text("error_code"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdUnique: uniqueIndex("heartbeat_run_attempts_org_id_uq").on(table.orgId, table.id),
    orgRunIdUnique: uniqueIndex("heartbeat_run_attempts_org_run_id_uq").on(table.orgId, table.runId, table.id),
    runAttemptUniqueIdx: uniqueIndex("heartbeat_run_attempts_run_attempt_uq").on(
      table.runId,
      table.attemptIndex,
    ),
    orgRunIdx: index("heartbeat_run_attempts_org_run_idx").on(table.orgId, table.runId, table.attemptIndex),
    agentCreatedIdx: index("heartbeat_run_attempts_agent_created_idx").on(table.agentId, table.createdAt),
    ownerFenceShapeCheck: check(
      "heartbeat_run_attempts_owner_fence_shape_check",
      sql`(
        (${table.ownerToken} is null and ${table.attemptEpoch} is null)
        or
        (${table.ownerToken} is not null and btrim(${table.ownerToken}) <> '' and ${table.attemptEpoch} is not null and ${table.attemptEpoch} > 0)
      )`,
    ),
    nativeChatEpochShapeCheck: check(
      "heartbeat_run_attempts_native_chat_epoch_shape_check",
      sql`((
        (${table.generationAttemptEpoch} is null and ${table.connectionEpoch} is null)
        or
        (${table.generationAttemptEpoch} > 0 and ${table.connectionEpoch} > 0
          and ${table.attemptEpoch} > 0 and ${table.ownerToken} is not null)
      ) is true)`,
    ),
    resumeSourceCheck: check(
      "heartbeat_run_attempts_resume_source_check",
      sql`${table.resumeSource} in ('fresh', 'same_session', 'pristine_replay')`,
    ),
    nativeChatProtocolPhaseCheck: check(
      "heartbeat_run_attempts_native_chat_protocol_phase_check",
      sql`((
        (${table.protocolPhase} is null and ${table.generationAttemptEpoch} is null and ${table.connectionEpoch} is null)
        or
        (${table.protocolPhase} in ('no_thread_request', 'thread_start_indeterminate', 'thread_known', 'input_pre_submission', 'input_indeterminate', 'turn_known', 'provider_terminal_observed', 'execution_terminal_committed')
          and ${table.generationAttemptEpoch} > 0 and ${table.connectionEpoch} > 0
          and jsonb_typeof(${table.checkpointJson}) = 'object'
          and ${table.checkpointJson}->>'phase' = ${table.protocolPhase})
      ) is true)`,
    ),
  }),
);
