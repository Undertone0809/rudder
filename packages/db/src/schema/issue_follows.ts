import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const issueFollows = pgTable(
  "issue_follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIssueIdx: index("issue_follows_org_issue_idx").on(table.orgId, table.issueId),
    orgUserIdx: index("issue_follows_org_user_idx").on(table.orgId, table.userId),
    orgUserIssueIdx: index("issue_follows_org_user_issue_idx").on(table.orgId, table.userId, table.issueId),
    orgIssueUserUnique: uniqueIndex("issue_follows_org_issue_user_idx").on(
      table.orgId,
      table.issueId,
      table.userId,
    ),
  }),
);
