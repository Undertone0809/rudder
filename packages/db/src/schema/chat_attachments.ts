import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { chatConversations } from "./chat_conversations.js";
import { chatMessages } from "./chat_messages.js";
import { organizations } from "./organizations.js";

export const chatAttachments = pgTable(
  "chat_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationMessageIdx: index("chat_attachments_conversation_message_idx").on(
      table.conversationId,
      table.messageId,
    ),
    companyConversationIdx: index("chat_attachments_company_conversation_idx").on(
      table.orgId,
      table.conversationId,
    ),
    assetUq: uniqueIndex("chat_attachments_asset_uq").on(table.assetId),
  }),
);
