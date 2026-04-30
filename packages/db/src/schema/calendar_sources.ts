import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";

export const calendarSources = pgTable(
  "calendar_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    type: text("type").notNull().default("rudder_local"),
    name: text("name").notNull(),
    ownerType: text("owner_type").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    externalProvider: text("external_provider"),
    externalCalendarId: text("external_calendar_id"),
    visibilityDefault: text("visibility_default").notNull().default("full"),
    status: text("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncCursorJson: jsonb("sync_cursor_json").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTypeIdx: index("calendar_sources_org_type_idx").on(table.orgId, table.type),
    externalIdx: index("calendar_sources_external_idx").on(
      table.orgId,
      table.externalProvider,
      table.externalCalendarId,
    ),
  }),
);
