import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    kind: text("kind").notNull().default("message"),
    status: text("status").notNull().default("completed"),
    body: text("body").notNull(),
    structuredPayload: jsonb("structured_payload").$type<Record<string, unknown> | null>(),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    replyingAgentId: uuid("replying_agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** User+assistant pairs that share a logical "turn" (for edit/regenerate variants). */
    chatTurnId: uuid("chat_turn_id"),
    turnVariant: integer("turn_variant").notNull().default(0),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationCreatedIdx: index("chat_messages_conversation_created_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    orgConversationCreatedIdx: index("chat_messages_org_conversation_created_idx").on(
      table.orgId,
      table.conversationId,
      table.createdAt,
    ),
    approvalIdx: index("chat_messages_approval_idx").on(table.approvalId),
  }),
);
