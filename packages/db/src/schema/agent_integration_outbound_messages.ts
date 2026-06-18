import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { chatConversations } from "./chat_conversations.js";
import { chatMessages } from "./chat_messages.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const agentIntegrationOutboundMessages = pgTable(
  "agent_integration_outbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => agentIntegrations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => chatConversations.id, { onDelete: "set null" }),
    chatMessageId: uuid("chat_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    externalChatId: text("external_chat_id").notNull(),
    externalMessageId: text("external_message_id"),
    status: text("status").notNull().default("pending"),
    lastPatchedAt: timestamp("last_patched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgStatusIdx: index("agent_integration_outbound_messages_org_status_idx").on(table.orgId, table.status),
    runIdx: index("agent_integration_outbound_messages_run_idx").on(table.runId),
    issueIdx: index("agent_integration_outbound_messages_issue_idx").on(table.issueId),
    externalMessageUq: uniqueIndex("agent_integration_outbound_messages_integration_external_message_uq").on(
      table.integrationId,
      table.externalMessageId,
    ),
  }),
);
