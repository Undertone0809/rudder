import type { ChatGenerationControlState, ChatGenerationStatus, NativeChatExecutionAuthority } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { nativeChatSourceMessageColumns } from "./chat_messages.js";
import { organizations } from "./organizations.js";

type NativeChatGenerationIdentityColumns = {
  orgId: AnyPgColumn;
  id: AnyPgColumn;
  conversationId: AnyPgColumn;
  executionAuthority: AnyPgColumn;
  nativeAdmissionHold: AnyPgColumn;
};

// heartbeat_runs refers to this identity through a deferred holder because of
// the existing chat_messages -> heartbeat_runs schema dependency.
export let nativeChatGenerationIdentityColumns: NativeChatGenerationIdentityColumns;

export const chatGenerations = pgTable(
  "chat_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
    /** Durable writer discriminator. Existing generations remain legacy_ts. */
    executionAuthority: text("execution_authority").$type<NativeChatExecutionAuthority>().notNull().default("legacy_ts"),
    /** Exact persisted source message and variant are the only native admission identity. */
    sourceMessageId: uuid("source_message_id"),
    sourceTurnVariant: integer("source_turn_variant"),
    /** Unresolved provider/process state retains the conversation admission slot. */
    nativeAdmissionHold: boolean("native_admission_hold").notNull().default(false),
    status: text("status").$type<ChatGenerationStatus>().notNull().default("active"),
    terminalReason: text("terminal_reason"),
    attemptEpoch: integer("attempt_epoch").notNull().default(1),
    controlVersion: integer("control_version").notNull().default(0),
    controlState: text("control_state").$type<ChatGenerationControlState>().notNull().default("unregistered"),
    controlRuntimeType: text("control_runtime_type"),
    controlOwnerToken: text("control_owner_token"),
    controlLeaseExpiresAt: timestamp("control_lease_expires_at", { withTimezone: true }),
    providerThreadId: text("provider_thread_id"),
    providerTurnId: text("provider_turn_id"),
    acceptedThroughSeq: integer("accepted_through_seq"),
    lastClientCheckpointSeq: integer("last_client_checkpoint_seq"),
    lastClientCheckpointHash: text("last_client_checkpoint_hash"),
    frozenBodyHash: text("frozen_body_hash"),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    runtimeTerminalAt: timestamp("runtime_terminal_at", { withTimezone: true }),
    lateEventsDropped: integer("late_events_dropped").notNull().default(0),
    lateBytes: bigint("late_bytes", { mode: "number" }).notNull().default(0),
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
    orgConversationIdentityFk: foreignKey({
      name: "chat_generations_org_conversation_fk",
      columns: [table.orgId, table.conversationId],
      foreignColumns: [chatConversations.orgId, chatConversations.id],
    }).onDelete("cascade"),
    nativeSourceMessageFk: foreignKey({
      name: "chat_generations_native_source_message_fk",
      columns: [table.orgId, table.sourceMessageId, table.conversationId, table.sourceTurnVariant],
      foreignColumns: [
        nativeChatSourceMessageColumns.orgId,
        nativeChatSourceMessageColumns.id,
        nativeChatSourceMessageColumns.conversationId,
        nativeChatSourceMessageColumns.turnVariant,
      ],
    }).onDelete("restrict"),
    orgConversationStartedIdx: index("chat_generations_org_conversation_started_idx").on(
      table.orgId,
      table.conversationId,
      table.startedAt,
    ),
    orgIdConversationAuthorityHoldUnique: uniqueIndex("chat_generations_org_id_conversation_authority_hold_uq").on(
      table.orgId,
      table.id,
      table.conversationId,
      table.executionAuthority,
      table.nativeAdmissionHold,
    ),
    nativeSourceIdentityUnique: uniqueIndex("chat_generations_native_source_identity_uq")
      .on(table.orgId, table.sourceMessageId, table.sourceTurnVariant)
      .where(sql`${table.sourceMessageId} is not null`),
    activeConversationUq: uniqueIndex("chat_generations_active_conversation_uq")
      .on(table.orgId, table.conversationId)
      .where(sql`${table.status} in ('starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping') or ${table.nativeAdmissionHold} = true`),
    nativeAuthorityShapeCheck: check(
      "chat_generations_native_authority_shape_check",
      sql`(
        (${table.executionAuthority} = 'legacy_ts' and ${table.sourceMessageId} is null
          and ${table.sourceTurnVariant} is null and ${table.nativeAdmissionHold} = false)
        or
        (${table.executionAuthority} = 'native_rust' and ${table.sourceMessageId} is not null
          and ${table.sourceTurnVariant} is not null and ${table.sourceTurnVariant} >= 0)
      )`,
    ),
    executionAuthorityCheck: check(
      "chat_generations_execution_authority_check",
      sql`${table.executionAuthority} in ('legacy_ts', 'native_rust')`,
    ),
    controlLeaseIdx: index("chat_generations_control_lease_idx").on(
      table.controlState,
      table.controlLeaseExpiresAt,
    ),
  }),
);

nativeChatGenerationIdentityColumns = {
  orgId: chatGenerations.orgId,
  id: chatGenerations.id,
  conversationId: chatGenerations.conversationId,
  executionAuthority: chatGenerations.executionAuthority,
  nativeAdmissionHold: chatGenerations.nativeAdmissionHold,
};
