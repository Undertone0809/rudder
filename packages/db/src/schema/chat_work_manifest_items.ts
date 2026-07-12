import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatConversations } from "./chat_conversations.js";
import { chatMessages } from "./chat_messages.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

export const chatWorkManifestItems = pgTable(
  "chat_work_manifest_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    messageId: uuid("message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    targetType: text("target_type").notNull(),
    targetKey: text("target_key").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    status: text("status").notNull().default("ready"),
    sourceRole: text("source_role"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationTargetUq: uniqueIndex("chat_work_manifest_items_conversation_target_uq").on(
      table.conversationId,
      table.targetKey,
    ),
    orgConversationCategoryIdx: index("chat_work_manifest_items_org_conversation_category_idx").on(
      table.orgId,
      table.conversationId,
      table.category,
    ),
    orgProjectCategoryIdx: index("chat_work_manifest_items_org_project_category_idx").on(
      table.orgId,
      table.projectId,
      table.category,
    ),
  }),
);
