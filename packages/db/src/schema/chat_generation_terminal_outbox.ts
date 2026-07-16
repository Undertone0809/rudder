import type { ChatTerminalOutboxStatus } from "@rudderhq/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatGenerationEvents } from "./chat_generation_events.js";
import { chatGenerations } from "./chat_generations.js";
import { organizations } from "./organizations.js";

export const chatGenerationTerminalOutbox = pgTable(
  "chat_generation_terminal_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    generationId: uuid("generation_id").notNull().references(() => chatGenerations.id, { onDelete: "cascade" }),
    sourceEventId: uuid("source_event_id").notNull().references(() => chatGenerationEvents.id, { onDelete: "cascade" }),
    projectionVersion: integer("projection_version").notNull(),
    projectorVersion: integer("projector_version").notNull().default(1),
    expectedControlVersion: integer("expected_control_version").notNull(),
    status: text("status").$type<ChatTerminalOutboxStatus>().notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    claimToken: text("claim_token"),
    claimEpoch: integer("claim_epoch").notNull().default(0),
    claimOwner: text("claim_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    replayCount: integer("replay_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    projectedAt: timestamp("projected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    generationProjectionUq: uniqueIndex("chat_generation_terminal_outbox_generation_projection_uq").on(
      table.generationId,
      table.projectionVersion,
    ),
    sourceEventUq: uniqueIndex("chat_generation_terminal_outbox_source_event_uq").on(table.sourceEventId),
    claimIdx: index("chat_generation_terminal_outbox_claim_idx").on(
      table.status,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    orgGenerationIdx: index("chat_generation_terminal_outbox_org_generation_idx").on(
      table.orgId,
      table.generationId,
    ),
  }),
);
