import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    kind: text("kind").notNull(),
    subtype: text("subtype").notNull(),
    status: text("status").notNull().default("open"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByUserId: text("requested_by_user_id"),
    originRunId: uuid("origin_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id, { onDelete: "set null" }),
    blockerFingerprint: text("blocker_fingerprint"),
    supersededByRequestId: uuid("superseded_by_request_id"),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    resolution: text("resolution"),
    response: text("response"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgStatusUpdatedIdx: index("requests_org_status_updated_idx").on(table.orgId, table.status, table.updatedAt),
    issueUpdatedIdx: index("requests_issue_updated_idx").on(table.issueId, table.updatedAt),
    openAssistanceLineageUniqueIdx: uniqueIndex("requests_open_assistance_lineage_uq")
      .on(table.orgId, table.issueId, table.blockerFingerprint)
      .where(sql`${table.kind} = 'assistance' and ${table.status} = 'open'`),
  }),
);

export const issueBlockAuditAttempts = pgTable(
  "issue_block_audit_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull().references(() => requests.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id),
    rootRunId: uuid("root_run_id").notNull().references(() => heartbeatRuns.id),
    previousRunId: uuid("previous_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    continuationKind: text("continuation_kind").notNull(),
    eligible: boolean("eligible").notNull().default(true),
    failureClass: text("failure_class").notNull(),
    blockerFingerprint: text("blocker_fingerprint").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    requiredAttempts: integer("required_attempts").notNull(),
    statusBefore: text("status_before").notNull(),
    statusAfter: text("status_after").notNull(),
    resetReason: text("reset_reason"),
    blockerReason: text("blocker_reason").notNull(),
    requestedAction: text("requested_action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueLineageIdx: index("issue_block_audit_attempts_issue_lineage_idx")
      .on(table.issueId, table.blockerFingerprint, table.attemptNumber),
    issueRunUniqueIdx: uniqueIndex("issue_block_audit_attempts_issue_run_uq").on(table.issueId, table.runId),
  }),
);
