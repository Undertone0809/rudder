import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const agentIssueCreationRequests = pgTable(
  "agent_issue_creation_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    requestedByUserId: text("requested_by_user_id").notNull(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    instruction: text("instruction").notNull(),
    projectId: uuid("project_id"),
    goalId: uuid("goal_id"),
    parentId: uuid("parent_id"),
    contextSnapshot: jsonb("context_snapshot").$type<Record<string, unknown>>(),
    idempotencyKey: text("idempotency_key").notNull(),
    wakeupAttempt: integer("wakeup_attempt").notNull().default(0),
    wakeupAttemptId: uuid("wakeup_attempt_id").notNull().defaultRandom(),
    wakeupRequestId: uuid("wakeup_request_id").references(() => agentWakeupRequests.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdIssueId: uuid("created_issue_id").references(() => issues.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    error: text("error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusUpdatedIdx: index("agent_issue_creation_requests_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
    requesterUpdatedIdx: index("agent_issue_creation_requests_requester_updated_idx").on(
      table.orgId,
      table.requestedByUserId,
      table.updatedAt,
    ),
    wakeupRequestIdx: index("agent_issue_creation_requests_wakeup_request_idx").on(table.wakeupRequestId),
    runIdx: index("agent_issue_creation_requests_run_idx").on(table.runId),
    createdIssueIdx: index("agent_issue_creation_requests_created_issue_idx").on(table.createdIssueId),
    orgRequesterIdempotencyUniqueIdx: uniqueIndex("agent_issue_creation_requests_org_requester_idempotency_uq").on(
      table.orgId,
      table.requestedByUserId,
      table.idempotencyKey,
    ),
    statusCheck: check(
      "agent_issue_creation_requests_status_check",
      sql`${table.status} in ('queued', 'running', 'deferred', 'succeeded', 'failed', 'cancelled')`,
    ),
  }),
);
