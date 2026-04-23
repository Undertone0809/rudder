import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    orgIdx: index("issue_comments_company_idx").on(table.orgId),
    orgIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.orgId,
      table.issueId,
      table.createdAt,
    ),
    orgAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.orgId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
