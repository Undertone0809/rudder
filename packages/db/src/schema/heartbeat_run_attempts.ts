import type {
  HeartbeatRunAttemptResumeSource,
  HeartbeatRunAttemptStatus,
} from "@rudderhq/shared";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    runAttemptUniqueIdx: uniqueIndex("heartbeat_run_attempts_run_attempt_uq").on(
      table.runId,
      table.attemptIndex,
    ),
    orgRunIdx: index("heartbeat_run_attempts_org_run_idx").on(table.orgId, table.runId, table.attemptIndex),
    agentCreatedIdx: index("heartbeat_run_attempts_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
