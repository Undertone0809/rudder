import type { ChatGenerationControlState, ChatGenerationStatus } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { organizations } from "./organizations.js";

export const chatGenerations = pgTable(
  "chat_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
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
    orgConversationStartedIdx: index("chat_generations_org_conversation_started_idx").on(
      table.orgId,
      table.conversationId,
      table.startedAt,
    ),
    activeConversationUq: uniqueIndex("chat_generations_active_conversation_uq")
      .on(table.orgId, table.conversationId)
      .where(sql`${table.status} in ('starting', 'active', 'running', 'waiting_for_network', 'tool_busy', 'closing', 'stop_requested', 'stopping')`),
    controlLeaseIdx: index("chat_generations_control_lease_idx").on(
      table.controlState,
      table.controlLeaseExpiresAt,
    ),
  }),
);
