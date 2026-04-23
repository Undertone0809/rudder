import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const chatConversationUserStates = pgTable(
  "chat_conversation_user_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgConversationIdx: index("chat_conversation_user_states_org_conversation_idx").on(
      table.orgId,
      table.conversationId,
    ),
    orgUserIdx: index("chat_conversation_user_states_org_user_idx").on(table.orgId, table.userId),
    orgConversationUserUnique: uniqueIndex("chat_conversation_user_states_org_conversation_user_idx").on(
      table.orgId,
      table.conversationId,
      table.userId,
    ),
  }),
);
