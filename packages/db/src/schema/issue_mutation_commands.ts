import { foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { approvals } from "./approvals.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

/**
 * Durable issue/governance command ledger. The organization is part of every
 * target foreign key so a command cannot replay against another organization's
 * issue, approval, or activity row.
 */
export const issueMutationCommands = pgTable(
  "issue_mutation_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id"),
    approvalId: uuid("approval_id"),
    commandType: text("command_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandFingerprint: text("command_fingerprint").notNull(),
    outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull(),
    activityId: uuid("activity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdempotencyUq: uniqueIndex("issue_mutation_commands_org_idempotency_uq").on(
      table.orgId,
      table.idempotencyKey,
    ),
    issueCreatedIdx: index("issue_mutation_commands_org_created_idx").on(
      table.orgId,
      table.issueId,
      table.createdAt,
    ),
    approvalCreatedIdx: index("issue_mutation_commands_approval_created_idx").on(
      table.orgId,
      table.approvalId,
      table.createdAt,
    ),
    orgIssueFk: foreignKey({
      columns: [table.orgId, table.issueId],
      foreignColumns: [issues.orgId, issues.id],
      name: "issue_mutation_commands_org_issue_fk",
    }).onDelete("cascade"),
    orgApprovalFk: foreignKey({
      columns: [table.orgId, table.approvalId],
      foreignColumns: [approvals.orgId, approvals.id],
      name: "issue_mutation_commands_org_approval_fk",
    }).onDelete("cascade"),
    orgActivityFk: foreignKey({
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
      name: "issue_mutation_commands_org_activity_fk",
    }),
  }),
);
