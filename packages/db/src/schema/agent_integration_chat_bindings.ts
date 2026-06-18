import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const agentIntegrationChatBindings = pgTable(
  "agent_integration_chat_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => agentIntegrations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "cascade" }),
    externalChatId: text("external_chat_id").notNull(),
    externalChatType: text("external_chat_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgConversationIdx: index("agent_integration_chat_bindings_org_conversation_idx").on(
      table.orgId,
      table.conversationId,
    ),
    integrationExternalChatUq: uniqueIndex("agent_integration_chat_bindings_integration_external_chat_uq").on(
      table.integrationId,
      table.externalChatId,
    ),
  }),
);
