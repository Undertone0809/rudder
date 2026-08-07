import { index, integer, jsonb, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { chatMessages } from "./chat_messages.js";
import { organizations } from "./organizations.js";

/**
 * Detached transcript snapshots for messages without a surviving generation
 * event ledger, including messages copied into a fork.
 */
export const chatMessageTranscriptEntries = pgTable(
  "chat_message_transcript_entries",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
    entrySeq: integer("entry_seq").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (table) => ({
    messageSeqPk: primaryKey({
      name: "chat_message_transcript_entries_message_seq_pk",
      columns: [table.messageId, table.entrySeq],
    }),
    orgMessageSeqIdx: index("chat_message_transcript_entries_org_message_seq_idx").on(
      table.orgId,
      table.messageId,
      table.entrySeq,
    ),
  }),
);
