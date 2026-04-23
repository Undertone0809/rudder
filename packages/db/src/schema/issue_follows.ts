import { index, pgTable, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { issues } from "./issues.js";

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
    orgIssueUserUnique: uniqueIndex("issue_follows_org_issue_user_idx").on(
      table.orgId,
      table.issueId,
      table.userId,
    ),
  }),
);
