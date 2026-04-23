import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { issues } from "./issues.js";

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    title: text("title").notNull().default("New chat"),
    summary: text("summary"),
    preferredAgentId: uuid("preferred_agent_id").references(() => agents.id, { onDelete: "set null" }),
    routedAgentId: uuid("routed_agent_id").references(() => agents.id, { onDelete: "set null" }),
    primaryIssueId: uuid("primary_issue_id").references(() => issues.id, { onDelete: "set null" }),
    issueCreationMode: text("issue_creation_mode").notNull().default("manual_approval"),
    planMode: boolean("plan_mode").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUpdatedIdx: index("chat_conversations_org_updated_idx").on(table.orgId, table.updatedAt),
    orgStatusUpdatedIdx: index("chat_conversations_org_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
    primaryIssueIdx: index("chat_conversations_primary_issue_idx").on(table.primaryIssueId),
  }),
);
