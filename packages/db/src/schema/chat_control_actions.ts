import type {
  ChatControlActionKind,
  ChatControlDisposition,
  ChatProviderControlDisposition,
} from "@rudderhq/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatGenerations } from "./chat_generations.js";
import { organizations } from "./organizations.js";

export const chatControlActions = pgTable(
  "chat_control_actions",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    expectedGenerationId: uuid("expected_generation_id").references(() => chatGenerations.id, { onDelete: "cascade" }),
    expectedAttemptEpoch: integer("expected_attempt_epoch"),
    expectedControlVersion: integer("expected_control_version"),
    appliedControlVersion: integer("applied_control_version"),
    actionKind: text("action_kind").$type<ChatControlActionKind>().notNull(),
    localDisposition: text("local_disposition").$type<ChatControlDisposition>().notNull().default("pending"),
    providerDisposition: text("provider_disposition").$type<ChatProviderControlDisposition>(),
    controlOwnerToken: text("control_owner_token"),
    providerClientMessageId: text("provider_client_message_id"),
    providerThreadId: text("provider_thread_id"),
    providerTurnId: text("provider_turn_id"),
    providerEvidence: jsonb("provider_evidence").$type<Record<string, unknown>>(),
    requestedRenderSeq: integer("requested_render_seq"),
    requestedBodyHash: text("requested_body_hash"),
    acceptedThroughSeq: integer("accepted_through_seq"),
    frozenBodyHash: text("frozen_body_hash"),
    lastError: text("last_error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    providerSentAt: timestamp("provider_sent_at", { withTimezone: true }),
    providerAcknowledgedAt: timestamp("provider_acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgActionUq: uniqueIndex("chat_control_actions_org_action_uq").on(table.orgId, table.id),
    generationRequestedIdx: index("chat_control_actions_generation_requested_idx").on(
      table.expectedGenerationId,
      table.requestedAt,
    ),
    orgDispositionIdx: index("chat_control_actions_org_disposition_idx").on(
      table.orgId,
      table.localDisposition,
      table.updatedAt,
    ),
  }),
);
