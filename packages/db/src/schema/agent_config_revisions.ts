import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";

export const agentConfigRevisions = pgTable(
  "agent_config_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    source: text("source").notNull().default("patch"),
    rolledBackFromRevisionId: uuid("rolled_back_from_revision_id"),
    changedKeys: jsonb("changed_keys").$type<string[]>().notNull().default([]),
    beforeConfig: jsonb("before_config").$type<Record<string, unknown>>().notNull(),
    afterConfig: jsonb("after_config").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentCreatedIdx: index("agent_config_revisions_company_agent_created_idx").on(
      table.orgId,
      table.agentId,
      table.createdAt,
    ),
    agentCreatedIdx: index("agent_config_revisions_agent_created_idx").on(table.agentId, table.createdAt),
  }),
);
