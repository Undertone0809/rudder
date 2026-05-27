import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const organizationIntelligenceProfiles = pgTable(
  "organization_intelligence_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    agentRuntimeType: text("agent_runtime_type").notNull(),
    agentRuntimeConfig: jsonb("agent_runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("configured"),
    lastError: text("last_error"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgPurposeIdx: uniqueIndex("organization_intelligence_profiles_org_purpose_idx").on(table.orgId, table.purpose),
    orgIdx: index("organization_intelligence_profiles_org_idx").on(table.orgId),
  }),
);
