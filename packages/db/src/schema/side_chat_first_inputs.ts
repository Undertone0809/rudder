import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatConversations } from "./chat_conversations.js";
import { chatGenerations } from "./chat_generations.js";
import { organizations } from "./organizations.js";

export const sideChatFirstInputs = pgTable(
  "side_chat_first_inputs",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").primaryKey().references(() => chatConversations.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id"),
    creationMutationId: text("creation_mutation_id").notNull(),
    sourceConversationId: uuid("source_conversation_id"),
    sourceMessageId: uuid("source_message_id"),
    preferredAgentId: uuid("preferred_agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").$type<"awaiting" | "pending" | "accepted">().notNull().default("awaiting"),
    requestClientMutationId: text("request_client_mutation_id"),
    requestFingerprint: text("request_fingerprint"),
    claimToken: uuid("claim_token"),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    userMessageId: uuid("user_message_id"),
    generationId: uuid("generation_id").references(() => chatGenerations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgStatusIdx: index("side_chat_first_inputs_org_status_idx").on(table.orgId, table.status),
    userMessageIdx: index("side_chat_first_inputs_user_message_idx").on(table.userMessageId),
    generationUq: uniqueIndex("side_chat_first_inputs_generation_uq")
      .on(table.generationId)
      .where(sql`${table.generationId} is not null`),
    statusCheck: check(
      "side_chat_first_inputs_status_check",
      sql`${table.status} in ('awaiting', 'pending', 'accepted')`,
    ),
    claimCheck: check(
      "side_chat_first_inputs_claim_check",
      sql`(
        (${table.status} = 'pending' and ${table.claimToken} is not null
          and ${table.claimExpiresAt} is not null and ${table.requestFingerprint} is not null)
        or (${table.status} <> 'pending' and ${table.claimToken} is null
          and ${table.claimExpiresAt} is null)
      )`,
    ),
    acceptedMessageCheck: check(
      "side_chat_first_inputs_accepted_message_check",
      sql`${table.status} <> 'accepted' or ${table.userMessageId} is not null`,
    ),
  }),
);
