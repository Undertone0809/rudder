import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_organization_settings` table — stores operator-managed plugin settings
 * scoped to a specific organization.
 *
 * This is distinct from `plugin_config`, which stores instance-wide plugin
 * configuration. Each organization can have at most one settings row per plugin.
 *
 * Rows represent explicit overrides from the default organization behavior:
 * - no row => plugin is enabled for the organization by default
 * - row with `enabled = false` => plugin is disabled for that organization
 * - row with `enabled = true` => plugin remains enabled and stores organization settings
 */
export const pluginOrganizationSettings = pgTable(
  "plugin_organization_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    settingsJson: jsonb("settings_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("plugin_organization_settings_org_idx").on(table.orgId),
    pluginIdx: index("plugin_organization_settings_plugin_idx").on(table.pluginId),
    organizationPluginUq: uniqueIndex("plugin_organization_settings_org_plugin_uq").on(
      table.orgId,
      table.pluginId,
    ),
  }),
);
