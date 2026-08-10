import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const pluginSources = pgTable("plugin_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),
  label: text("label").notNull(),
  locator: text("locator"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgIdx: index("plugin_sources_org_idx").on(table.orgId),
  sourceTypeCheck: check("plugin_sources_type_check", sql`${table.sourceType} in ('local_upload', 'marketplace', 'git', 'package')`),
}));

export const pluginPackages = pgTable("plugin_packages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").references(() => pluginSources.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  version: text("version").notNull(),
  digest: text("digest").notNull(),
  rawManifest: jsonb("raw_manifest").$type<Record<string, unknown>>().notNull(),
  normalizedManifest: jsonb("normalized_manifest").$type<Record<string, unknown>>().notNull(),
  snapshot: jsonb("snapshot").$type<Array<{ path: string; content: string; encoding: "base64" }>>().notNull(),
  compatibility: jsonb("compatibility").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  digestUnique: uniqueIndex("plugin_packages_digest_uq").on(table.digest),
  identityIdx: index("plugin_packages_identity_idx").on(table.name, table.version),
}));

export const installedPlugins = pgTable("installed_plugins", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  packageId: uuid("package_id").notNull().references(() => pluginPackages.id),
  previousPackageId: uuid("previous_package_id").references(() => pluginPackages.id, { onDelete: "set null" }),
  sourceId: uuid("source_id").references(() => pluginSources.id, { onDelete: "set null" }),
  packageName: text("package_name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lifecycleState: text("lifecycle_state").notNull().default("installed"),
  setupState: text("setup_state").notNull().default("not_required"),
  healthState: text("health_state").notNull().default("unknown"),
  updateState: text("update_state").notNull().default("none"),
  lastOperation: jsonb("last_operation").$type<Record<string, unknown>>().notNull().default({}),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgPackageNameUnique: uniqueIndex("installed_plugins_org_package_name_uq")
    .on(table.orgId, table.packageName)
    .where(sql`${table.lifecycleState} <> 'uninstalled'`),
  orgLifecycleIdx: index("installed_plugins_org_lifecycle_idx").on(table.orgId, table.lifecycleState),
  lifecycleCheck: check("installed_plugins_lifecycle_check", sql`${table.lifecycleState} in ('installed', 'uninstalling', 'uninstalled')`),
  setupCheck: check("installed_plugins_setup_check", sql`${table.setupState} in ('not_required', 'setup_required', 'configuring', 'ready', 'blocked')`),
  healthCheck: check("installed_plugins_health_check", sql`${table.healthState} in ('unknown', 'healthy', 'degraded', 'unavailable')`),
  updateCheck: check("installed_plugins_update_check", sql`${table.updateState} in ('none', 'available', 'review_required', 'applying', 'failed')`),
}));

export const pluginComponentLinks = pgTable("plugin_component_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  installedPluginId: uuid("installed_plugin_id").notNull().references(() => installedPlugins.id, { onDelete: "cascade" }),
  componentType: text("component_type").notNull(),
  componentKey: text("component_key").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status").notNull(),
  targetId: uuid("target_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pluginComponentUnique: uniqueIndex("plugin_component_links_plugin_key_uq").on(table.installedPluginId, table.componentType, table.componentKey),
  orgTargetIdx: index("plugin_component_links_org_target_idx").on(table.orgId, table.targetId),
  typeCheck: check("plugin_component_links_type_check", sql`${table.componentType} in ('skill', 'mcp', 'app', 'unsupported')`),
  statusCheck: check("plugin_component_links_status_check", sql`${table.status} in ('ready', 'setup_required', 'unsupported', 'disabled')`),
}));

export const pluginImportReports = pgTable("plugin_import_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  packageId: uuid("package_id").references(() => pluginPackages.id, { onDelete: "set null" }),
  sourceId: uuid("source_id").references(() => pluginSources.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull(),
  sourceLabel: text("source_label").notNull(),
  status: text("status").notNull(),
  digest: text("digest"),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgCreatedIdx: index("plugin_import_reports_org_created_idx").on(table.orgId, table.createdAt),
  statusCheck: check("plugin_import_reports_status_check", sql`${table.status} in ('review_required', 'accepted', 'rejected', 'failed')`),
}));
