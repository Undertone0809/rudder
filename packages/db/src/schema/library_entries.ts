import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const libraryEntries = pgTable(
  "library_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("file"),
    sourceType: text("source_type").notNull().default("workspace_file"),
    currentPath: text("current_path"),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("library_entries_org_idx").on(table.orgId),
    orgStatusIdx: index("library_entries_org_status_idx").on(table.orgId, table.status),
    orgCurrentPathUq: uniqueIndex("library_entries_org_current_path_uq").on(table.orgId, table.currentPath),
  }),
);
