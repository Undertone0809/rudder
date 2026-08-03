/**
 * @fileoverview Heartbeat run table schema for queued/running/completed agent
 * work, transcript storage pointers, process metadata, and recovery linkage.
 *
 * @see doc/product/domains/execution/agent-runs.md - durable run lifecycle
 * @see doc/product/domains/execution/transcripts-and-results.md - transcript and result persistence
 * @see doc/product/domains/execution/run-admission-and-recovery.md - retry and process-loss recovery
 */
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { chatConversations } from "./chat_conversations.js";
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
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id),
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
    processPid: integer("process_pid"),
    processStartedAt: timestamp("process_started_at", { withTimezone: true }),
    processExitedAt: timestamp("process_exited_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCreatedIdIdx: index("heartbeat_runs_org_created_id_idx").on(
      table.orgId,
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
    statusExecutionLeaseCreatedIdx: index("heartbeat_runs_status_execution_lease_created_idx").on(
      table.status,
      table.executionLeaseExpiresAt,
      table.createdAt,
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
    sessionReuseScopeCheck: check(
      "heartbeat_runs_session_reuse_scope_check",
      sql`${table.sessionReuseScope} in ('explicit', 'task', 'none', 'unknown')`,
    ),
  }),
);
