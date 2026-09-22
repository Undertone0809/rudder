/**
 * @fileoverview Heartbeat run table schema for queued/running/completed agent
 * work, transcript storage pointers, process metadata, and recovery linkage.
 *
 * @see doc/product/domains/execution/agent-runs.md - durable run lifecycle
 * @see doc/product/domains/execution/transcripts-and-results.md - transcript and result persistence
 * @see doc/product/domains/execution/run-admission-and-recovery.md - retry and process-loss recovery
 */
import type { HeartbeatRunExecutionPhase } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { chatConversations } from "./chat_conversations.js";
import { goals } from "./goals.js";
import { organizations } from "./organizations.js";

export const heartbeatRuns = pgTable(
  "heartbeat_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    invocationSource: text("invocation_source").notNull().default("on_demand"),
    triggerDetail: text("trigger_detail"),
    status: text("status").notNull().default("queued"),
    /** A running run may be executing or durably waiting for provider network. */
    runningSubstate: text("running_substate").$type<HeartbeatRunExecutionPhase | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
    sourceRunId: uuid("source_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    usageJson: jsonb("usage_json").$type<Record<string, unknown>>(),
    resultJson: jsonb("result_json").$type<Record<string, unknown>>(),
    resultSummaryJson: jsonb("result_summary_json").$type<Record<string, unknown>>(),
    sessionIdBefore: text("session_id_before"),
    sessionIdAfter: text("session_id_after"),
    sessionParamsBeforeJson: jsonb("session_params_before_json").$type<Record<string, unknown>>(),
    sessionParamsAfterJson: jsonb("session_params_after_json").$type<Record<string, unknown>>(),
    sessionReuseScope: text("session_reuse_scope")
      .$type<"explicit" | "task" | "none" | "unknown">()
      .notNull()
      .default("unknown"),
    logStore: text("log_store"),
    logRef: text("log_ref"),
    logBytes: bigint("log_bytes", { mode: "number" }),
    logSha256: text("log_sha256"),
    logCompressed: boolean("log_compressed").notNull().default(false),
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    errorCode: text("error_code"),
    externalRunId: text("external_run_id"),
    chatConversationId: uuid("chat_conversation_id").references((): AnyPgColumn => chatConversations.id, {
      onDelete: "set null",
    }),
    /** Explicit Goal ownership for Goal Detail timelines; contextSnapshot remains compatibility data. */
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    processPid: integer("process_pid"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    processExitedAt: timestamp("process_exited_at", { withTimezone: true }),
    networkWaitStartedAt: timestamp("network_wait_started_at", { withTimezone: true }),
    networkWaitNextRetryAt: timestamp("network_wait_next_retry_at", { withTimezone: true }),
    networkWaitAttemptCount: integer("network_wait_attempt_count").notNull().default(0),
    networkWaitDurationMs: bigint("network_wait_duration_ms", { mode: "number" }).notNull().default(0),
    recoveryCheckpoint: jsonb("recovery_checkpoint").$type<Record<string, unknown>>(),
    executionOwnerToken: text("execution_owner_token"),
    executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
    terminalEffectsPending: boolean("terminal_effects_pending").notNull().default(false),
    terminalEffectsJson: jsonb("terminal_effects_json").$type<Record<string, unknown>>(),
    terminalEffectsCompletedJson: jsonb("terminal_effects_completed_json").$type<string[]>(),
    terminalEffectsDeadLetteredJson: jsonb("terminal_effects_dead_lettered_json").$type<string[]>(),
    terminalEffectsAttemptsJson: jsonb("terminal_effects_attempts_json").$type<Record<string, number>>(),
    terminalEffectsNextAttemptAt: timestamp("terminal_effects_next_attempt_at", { withTimezone: true }),
    terminalEffectsDeadLetteredAt: timestamp("terminal_effects_dead_lettered_at", { withTimezone: true }),
    terminalEffectsClaimToken: text("terminal_effects_claim_token"),
    terminalEffectsClaimedAt: timestamp("terminal_effects_claimed_at", { withTimezone: true }),
    terminalEffectsAttemptCount: integer("terminal_effects_attempt_count").notNull().default(0),
    terminalEffectsLastError: text("terminal_effects_last_error"),
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    processLossRetryCount: integer("process_loss_retry_count").notNull().default(0),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    /** Durable common-run admission identity; legacy rows leave these nullable. */
    scene: text("scene"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    idempotencyKey: text("idempotency_key"),
    sessionIntentJson: jsonb("session_intent_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdUnique: uniqueIndex("heartbeat_runs_org_id_uq").on(table.orgId, table.id),
    orgCreatedIdIdx: index("heartbeat_runs_org_created_id_idx").on(
      table.orgId,
      table.createdAt,
      table.id,
    ),
    orgGoalCreatedIdIdx: index("heartbeat_runs_org_goal_created_id_idx").on(
      table.orgId,
      table.goalId,
      table.createdAt,
      table.id,
    ),
    companyAgentStartedIdx: index("heartbeat_runs_company_agent_started_idx").on(
      table.orgId,
      table.agentId,
      table.startedAt,
    ),
    orgAgentCreatedIdIdx: index("heartbeat_runs_org_agent_created_id_idx").on(
      table.orgId,
      table.agentId,
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    companyStatusUpdatedIdx: index("heartbeat_runs_company_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
    companySourceRunIdx: index("heartbeat_runs_company_source_run_idx").on(
      table.orgId,
      table.sourceRunId,
    ),
    statusExecutionLeaseCreatedIdx: index("heartbeat_runs_status_execution_lease_created_idx").on(
      table.status,
      table.executionLeaseExpiresAt,
      table.createdAt,
    ),
    networkWaitRecoveryIdx: index("heartbeat_runs_network_wait_recovery_idx").on(
      table.status,
      table.runningSubstate,
      table.networkWaitNextRetryAt,
    ),
    companyChatConversationStatusUpdatedIdx: index("heartbeat_runs_company_chat_conversation_status_updated_idx").on(
      table.orgId,
      table.chatConversationId,
      table.status,
      table.updatedAt,
    ),
    activeChatConversationUniqueIdx: uniqueIndex("heartbeat_runs_active_chat_conversation_uq")
      .on(table.orgId, table.chatConversationId)
      .where(sql`${table.chatConversationId} is not null and (${table.status} in ('queued', 'running') or ${table.terminalEffectsPending} = true)`),
    orgIdempotencyKeyUniqueIdx: uniqueIndex("heartbeat_runs_org_idempotency_key_uq")
      .on(table.orgId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    sessionReuseScopeCheck: check(
      "heartbeat_runs_session_reuse_scope_check",
      sql`${table.sessionReuseScope} in ('explicit', 'task', 'none', 'unknown')`,
    ),
    commonRunIdentityCheck: check(
      "heartbeat_runs_common_run_identity_check",
      sql`(
        (${table.scene} is null and ${table.targetType} is null and ${table.targetId} is null
          and ${table.idempotencyKey} is null and ${table.sessionIntentJson} is null)
        or
        (${table.scene} is not null and ${table.targetType} is not null and ${table.targetId} is not null
          and ${table.idempotencyKey} is not null and ${table.sessionIntentJson} is not null)
      )`,
    ),
    sceneCheck: check(
      "heartbeat_runs_scene_check",
      sql`${table.scene} is null or ${table.scene} in ('chat', 'side_chat', 'issue', 'review', 'automation', 'heartbeat', 'delegation')`,
    ),
    targetCheck: check(
      "heartbeat_runs_target_check",
      sql`(
        (${table.targetType} is null and ${table.targetId} is null)
        or
        (${table.targetType} in ('issue', 'chat_conversation', 'chat_message', 'automation_run', 'wakeup_request', 'manual', 'review')
          and ${table.targetId} is not null and ${table.targetId} = btrim(${table.targetId}) and btrim(${table.targetId}) <> '')
      )`,
    ),
    idempotencyKeyCheck: check(
      "heartbeat_runs_idempotency_key_check",
      sql`${table.idempotencyKey} is null or (${table.idempotencyKey} = btrim(${table.idempotencyKey}) and octet_length(${table.idempotencyKey}) between 1 and 512)`,
    ),
    sessionIntentShapeCheck: check(
      "heartbeat_runs_session_intent_shape_check",
      sql`(
        ${table.sessionIntentJson} is null
        or (
          jsonb_typeof(${table.sessionIntentJson}) = 'object'
          and ${table.sessionIntentJson} ?& array['kind', 'reuseScope', 'sourceRunId', 'sessionId', 'sessionParams']
          and jsonb_typeof(${table.sessionIntentJson}->'kind') = 'string'
          and jsonb_typeof(${table.sessionIntentJson}->'reuseScope') = 'string'
          and ${table.sessionIntentJson}->>'kind' in ('fresh', 'resume', 'fork')
          and (
            (
              ${table.sessionIntentJson}->>'kind' = 'fresh'
              and ${table.sessionIntentJson}->>'reuseScope' = 'none'
              and jsonb_typeof(${table.sessionIntentJson}->'sourceRunId') = 'null'
              and jsonb_typeof(${table.sessionIntentJson}->'sessionId') = 'null'
              and jsonb_typeof(${table.sessionIntentJson}->'sessionParams') = 'null'
              and not (${table.sessionIntentJson} ? 'sourceBoundaryRef')
            )
            or
            (
              ${table.sessionIntentJson}->>'kind' = 'resume'
              and ${table.sessionIntentJson}->>'reuseScope' in ('explicit', 'task')
              and (
                jsonb_typeof(${table.sessionIntentJson}->'sourceRunId') = 'null'
                or (jsonb_typeof(${table.sessionIntentJson}->'sourceRunId') = 'string' and ${table.sessionIntentJson}->>'sourceRunId' = btrim(${table.sessionIntentJson}->>'sourceRunId') and btrim(${table.sessionIntentJson}->>'sourceRunId') <> '')
              )
              and (
                jsonb_typeof(${table.sessionIntentJson}->'sessionId') = 'null'
                or (jsonb_typeof(${table.sessionIntentJson}->'sessionId') = 'string' and ${table.sessionIntentJson}->>'sessionId' = btrim(${table.sessionIntentJson}->>'sessionId') and btrim(${table.sessionIntentJson}->>'sessionId') <> '')
              )
              and jsonb_typeof(${table.sessionIntentJson}->'sessionParams') in ('null', 'object')
              and not (${table.sessionIntentJson} ? 'sourceBoundaryRef')
            )
            or
            (
              ${table.sessionIntentJson}->>'kind' = 'fork'
              and ${table.sessionIntentJson}->>'reuseScope' = 'explicit'
              and jsonb_typeof(${table.sessionIntentJson}->'sourceRunId') = 'string'
              and ${table.sessionIntentJson}->>'sourceRunId' = btrim(${table.sessionIntentJson}->>'sourceRunId')
              and btrim(${table.sessionIntentJson}->>'sourceRunId') <> ''
              and ${table.sessionIntentJson} ? 'sourceBoundaryRef'
              and jsonb_typeof(${table.sessionIntentJson}->'sourceBoundaryRef') = 'string'
              and ${table.sessionIntentJson}->>'sourceBoundaryRef' = btrim(${table.sessionIntentJson}->>'sourceBoundaryRef')
              and btrim(${table.sessionIntentJson}->>'sourceBoundaryRef') <> ''
              and (
                jsonb_typeof(${table.sessionIntentJson}->'sessionId') = 'null'
                or (jsonb_typeof(${table.sessionIntentJson}->'sessionId') = 'string' and ${table.sessionIntentJson}->>'sessionId' = btrim(${table.sessionIntentJson}->>'sessionId') and btrim(${table.sessionIntentJson}->>'sessionId') <> '')
              )
              and jsonb_typeof(${table.sessionIntentJson}->'sessionParams') in ('null', 'object')
            )
          )
        )
      )`,
    ),
  }),
);
