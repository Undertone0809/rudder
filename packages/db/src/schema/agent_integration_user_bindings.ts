import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agentIntegrations } from "./agent_integrations.js";
import { organizations } from "./organizations.js";

export const agentIntegrationUserBindings = pgTable(
  "agent_integration_user_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => agentIntegrations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    externalOpenId: text("external_open_id").notNull(),
    externalUnionId: text("external_union_id"),
    boundAt: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserIdx: index("agent_integration_user_bindings_org_user_idx").on(table.orgId, table.userId),
    integrationOpenIdUq: uniqueIndex("agent_integration_user_bindings_integration_open_id_uq").on(
      table.integrationId,
      table.externalOpenId,
    ),
    integrationUnionIdIdx: index("agent_integration_user_bindings_integration_union_id_idx").on(
      table.integrationId,
      table.externalUnionId,
    ),
  }),
);
