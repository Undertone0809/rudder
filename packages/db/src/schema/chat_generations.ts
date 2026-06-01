import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const chatGenerations = pgTable(
  "chat_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    terminalReason: text("terminal_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationStatusIdx: index("chat_generations_conversation_status_idx").on(
      table.conversationId,
      table.status,
    ),
    orgConversationStartedIdx: index("chat_generations_org_conversation_started_idx").on(
      table.orgId,
      table.conversationId,
      table.startedAt,
    ),
  }),
);
