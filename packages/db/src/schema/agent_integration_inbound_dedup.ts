import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { organizations } from "./organizations.js";

export const agentIntegrationInboundDedup = pgTable(
  "agent_integration_inbound_dedup",
  {
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id").references(() => agentIntegrations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    externalEventId: text("external_event_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: "agent_integration_inbound_dedup_pk",
      columns: [table.provider, table.externalMessageId],
    }),
    orgReceivedIdx: index("agent_integration_inbound_dedup_org_received_idx").on(table.orgId, table.receivedAt),
    integrationReceivedIdx: index("agent_integration_inbound_dedup_integration_received_idx").on(
      table.integrationId,
      table.receivedAt,
    ),
  }),
);
