import type {
  ChatControlDisposition,
  ChatQueueDeliveryIntent,
  ChatQueueRequestActor,
  ChatQueuedMessageStatus,
} from "@rudderhq/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatControlActions } from "./chat_control_actions.js";
import { chatConversations } from "./chat_conversations.js";
import { chatGenerations } from "./chat_generations.js";
import { chatMessages } from "./chat_messages.js";
import { organizations } from "./organizations.js";

export const chatQueuedMessages = pgTable(
  "chat_queued_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    status: text("status").$type<ChatQueuedMessageStatus>().notNull().default("queued"),
    version: integer("version").notNull().default(1),
    clientMutationId: text("client_mutation_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    requestActor: jsonb("request_actor").$type<ChatQueueRequestActor>(),
    deliveryIntent: text("delivery_intent").$type<ChatQueueDeliveryIntent>().notNull().default("queue"),
    deliveryDisposition: text("delivery_disposition").$type<ChatControlDisposition>(),
    controlActionId: uuid("control_action_id").references(() => chatControlActions.id, { onDelete: "set null" }),
    expectedGenerationId: uuid("expected_generation_id").references(() => chatGenerations.id, { onDelete: "set null" }),
    activeGenerationId: uuid("active_generation_id").references(() => chatGenerations.id, { onDelete: "set null" }),
    attemptEpoch: integer("attempt_epoch"),
    providerClientMessageId: text("provider_client_message_id"),
    providerThreadId: text("provider_thread_id"),
    providerTurnId: text("provider_turn_id"),
    providerEvidence: jsonb("provider_evidence").$type<Record<string, unknown>>(),
    continuationGenerationId: uuid("continuation_generation_id").references(() => chatGenerations.id, { onDelete: "set null" }),
    continuationMessageId: uuid("continuation_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    deliveryLeaseToken: text("delivery_lease_token"),
    deliveryLeaseEpoch: integer("delivery_lease_epoch").notNull().default(0),
    deliveryLeaseOwner: text("delivery_lease_owner"),
    deliveryLeaseExpiresAt: timestamp("delivery_lease_expires_at", { withTimezone: true }),
    reconciliationReason: text("reconciliation_reason"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastDeliveryReason: text("last_delivery_reason"),
    sourceMessageId: uuid("source_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    deliveredMessageId: uuid("delivered_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    steeredAt: timestamp("steered_at", { withTimezone: true }),
    dequeuedAt: timestamp("dequeued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationStatusPositionIdx: index("chat_queued_messages_conversation_status_position_idx").on(
      table.conversationId,
      table.status,
      table.position,
    ),
    orgConversationIdx: index("chat_queued_messages_org_conversation_idx").on(
      table.orgId,
      table.conversationId,
    ),
    conversationPositionUq: uniqueIndex("chat_queued_messages_conversation_position_uq").on(
      table.conversationId,
      table.position,
    ),
    conversationMutationUq: uniqueIndex("chat_queued_messages_conversation_mutation_uq").on(
      table.conversationId,
      table.clientMutationId,
    ),
    controlActionUq: uniqueIndex("chat_queued_messages_control_action_uq").on(table.controlActionId),
    continuationGenerationUq: uniqueIndex("chat_queued_messages_continuation_generation_uq").on(
      table.continuationGenerationId,
    ),
    continuationMessageUq: uniqueIndex("chat_queued_messages_continuation_message_uq").on(
      table.continuationMessageId,
    ),
    deliveryClaimIdx: index("chat_queued_messages_delivery_claim_idx").on(
      table.orgId,
      table.status,
      table.deliveryLeaseExpiresAt,
    ),
    intentPositionIdx: index("chat_queued_messages_intent_position_idx").on(
      table.orgId,
      table.conversationId,
      table.deliveryIntent,
      table.status,
      table.position,
    ),
  }),
);
