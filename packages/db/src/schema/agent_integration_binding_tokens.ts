import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { organizations } from "./organizations.js";

export const agentIntegrationBindingTokens = pgTable(
  "agent_integration_binding_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => agentIntegrations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    externalOpenId: text("external_open_id").notNull(),
    externalUnionId: text("external_union_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("agent_integration_binding_tokens_token_hash_uq").on(table.tokenHash),
    integrationOpenIdIdx: index("agent_integration_binding_tokens_integration_open_id_idx").on(
      table.integrationId,
      table.externalOpenId,
    ),
    expiryIdx: index("agent_integration_binding_tokens_expiry_idx").on(table.expiresAt),
  }),
);
