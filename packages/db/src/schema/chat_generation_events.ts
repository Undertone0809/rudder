import type { ChatGenerationEventKind } from "@rudderhq/shared";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatControlActions } from "./chat_control_actions.js";
import { chatGenerations } from "./chat_generations.js";
import { chatMessages } from "./chat_messages.js";
import { chatQueuedMessages } from "./chat_queued_messages.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";

export const chatGenerationEvents = pgTable(
  "chat_generation_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    generationId: uuid("generation_id").notNull().references(() => chatGenerations.id, { onDelete: "cascade" }),
    generationSeq: integer("generation_seq").notNull(),
    attemptEpoch: integer("attempt_epoch").notNull(),
    eventKind: text("event_kind").$type<ChatGenerationEventKind>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    bodyOffset: integer("body_offset"),
    bodyLength: integer("body_length"),
    assistantMessageId: uuid("assistant_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    controlActionId: uuid("control_action_id").references(() => chatControlActions.id, { onDelete: "set null" }),
    queueItemId: uuid("queue_item_id").references(() => chatQueuedMessages.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    emittedAt: timestamp("emitted_at", { withTimezone: true }),
  },
  (table) => ({
    generationSeqUq: uniqueIndex("chat_generation_events_generation_seq_uq").on(
      table.generationId,
      table.generationSeq,
    ),
    orgGenerationSeqIdx: index("chat_generation_events_org_generation_seq_idx").on(
      table.orgId,
      table.generationId,
      table.generationSeq,
    ),
    assistantMessageIdx: index("chat_generation_events_assistant_message_idx").on(table.assistantMessageId),
    runIdx: index("chat_generation_events_run_idx").on(table.runId),
    controlActionIdx: index("chat_generation_events_control_action_idx").on(table.controlActionId),
    queueItemIdx: index("chat_generation_events_queue_item_idx").on(table.queueItemId),
  }),
);
