import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export type SideChatCloseAttachment = { orgId: string; assetId: string; objectKey: string; provider: string };
export type SideChatCloseState = "requested" | "claimed" | "retry_wait" | "review_required";

/** Survives conversation deletion so object cleanup can resume after a crash. */
export const sideChatCloseIntents = pgTable(
  "side_chat_close_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    sourceConversationId: uuid("source_conversation_id"),
    sourceMessageId: uuid("source_message_id"),
    state: text("state").$type<SideChatCloseState>().notNull().default("requested"),
    stopGenerationId: uuid("stop_generation_id"),
    stopControlActionId: uuid("stop_control_action_id").notNull().defaultRandom(),
    attachmentsJson: jsonb("attachments_json").$type<SideChatCloseAttachment[]>().notNull().default([]),
    attachmentCursor: integer("attachment_cursor").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    leaseOwner: text("lease_owner"),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationUnique: uniqueIndex("side_chat_close_conversation_uq").on(table.orgId, table.conversationId),
    claimIdx: index("side_chat_close_claim_idx").on(table.state, table.nextAttemptAt, table.leaseExpiresAt),
    stateCheck: check(
      "side_chat_close_state_check",
      sql`${table.state} in ('requested', 'claimed', 'retry_wait', 'review_required')`,
    ),
    leaseCheck: check(
      "side_chat_close_lease_check",
      sql`(
        (${table.state} = 'claimed' and ${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)
        or (${table.state} <> 'claimed' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)
      )`,
    ),
    cursorCheck: check(
      "side_chat_close_cursor_check",
      sql`${table.attachmentCursor} >= 0 and ${table.leaseEpoch} >= 0 and ${table.attemptCount} >= 0`,
    ),
  }),
);
