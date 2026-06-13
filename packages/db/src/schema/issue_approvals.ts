import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const issueApprovals = pgTable(
  "issue_approvals",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    linkedByUserId: text("linked_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.approvalId], name: "issue_approvals_pk" }),
    issueIdx: index("issue_approvals_issue_idx").on(table.issueId),
    approvalIdx: index("issue_approvals_approval_idx").on(table.approvalId),
    orgIdx: index("issue_approvals_company_idx").on(table.orgId),
  }),
);
