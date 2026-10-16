import { sql } from "drizzle-orm";
import { type AnyPgColumn, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { chatConversations } from "./chat_conversations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";

type NativeChatSourceMessageColumns = {
  orgId: AnyPgColumn;
  id: AnyPgColumn;
  conversationId: AnyPgColumn;
  turnVariant: AnyPgColumn;
};

// Cross-table composite keys are read by the extra-config callback after every
// schema module has initialized. This deferred holder avoids an ESM TDZ cycle
// through chat_messages -> heartbeat_runs -> chat_generations -> chat_messages.
export let nativeChatSourceMessageColumns: NativeChatSourceMessageColumns;

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
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    replyingAgentId: uuid("replying_agent_id").references(() => agents.id, { onDelete: "set null" }),
    clientMutationId: text("client_mutation_id"),
    clientMutationFingerprint: text("client_mutation_fingerprint"),
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
    runIdx: index("chat_messages_run_idx").on(table.runId),
    conversationMutationIdx: uniqueIndex("chat_messages_conversation_mutation_uq")
      .on(table.conversationId, table.clientMutationId)
      .where(sql`${table.clientMutationId} is not null`),
    orgMessageConversationVariantUnique: uniqueIndex("chat_messages_org_id_conversation_variant_uq").on(
      table.orgId,
      table.id,
      table.conversationId,
      table.turnVariant,
    ),
    turnVariantCheck: check("chat_messages_turn_variant_check", sql`${table.turnVariant} >= 0`),
  }),
);

nativeChatSourceMessageColumns = {
  orgId: chatMessages.orgId,
  id: chatMessages.id,
  conversationId: chatMessages.conversationId,
  turnVariant: chatMessages.turnVariant,
};
