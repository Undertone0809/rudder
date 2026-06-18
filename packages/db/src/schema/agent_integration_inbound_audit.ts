import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { organizations } from "./organizations.js";

export const agentIntegrationInboundAudit = pgTable(
  "agent_integration_inbound_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => agentIntegrations.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalChatId: text("external_chat_id"),
    externalChatType: text("external_chat_type"),
    externalEventId: text("external_event_id"),
    externalMessageId: text("external_message_id"),
    senderOpenId: text("sender_open_id"),
    dropReason: text("drop_reason").notNull(),
    bodyPersisted: boolean("body_persisted").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgReasonReceivedIdx: index("agent_integration_inbound_audit_org_reason_received_idx").on(
      table.orgId,
      table.dropReason,
      table.receivedAt,
    ),
    integrationReceivedIdx: index("agent_integration_inbound_audit_integration_received_idx").on(
      table.integrationId,
      table.receivedAt,
    ),
    messageIdx: index("agent_integration_inbound_audit_message_idx").on(table.provider, table.externalMessageId),
  }),
);
