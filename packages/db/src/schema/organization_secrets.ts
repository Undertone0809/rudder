import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";

export const organizationSecrets = pgTable(
  "organization_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("local_encrypted"),
    externalRef: text("external_ref"),
    latestVersion: integer("latest_version").notNull().default(1),
    description: text("description"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("organization_secrets_org_idx").on(table.orgId),
    organizationProviderIdx: index("organization_secrets_org_provider_idx").on(table.orgId, table.provider),
    organizationNameUq: uniqueIndex("organization_secrets_org_name_uq").on(table.orgId, table.name),
  }),
);
