import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const chatContextLinks = pgTable(
  "chat_context_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationEntityIdx: index("chat_context_links_conversation_entity_idx").on(
      table.conversationId,
      table.entityType,
      table.entityId,
    ),
    companyEntityIdx: index("chat_context_links_company_entity_idx").on(
      table.orgId,
      table.entityType,
      table.entityId,
    ),
    uniqueConversationEntityIdx: uniqueIndex("chat_context_links_unique_conversation_entity_idx").on(
      table.conversationId,
      table.entityType,
      table.entityId,
    ),
  }),
);
