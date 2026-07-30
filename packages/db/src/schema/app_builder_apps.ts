import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

export const appBuilderApps = pgTable(
  "app_builder_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => chatConversations.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    sourceRoot: text("source_root").notNull(),
    scaffoldVersion: text("scaffold_version").notNull(),
    buildStatus: text("build_status").notNull().default("preparing"),
    latestBuildRunId: uuid("latest_build_run_id").references(() => heartbeatRuns.id, {
      onDelete: "set null",
    }),
    latestVerificationRunId: uuid("latest_verification_run_id").references(
      () => heartbeatRuns.id,
      { onDelete: "set null" },
    ),
    desktopInstallationId: text("desktop_installation_id"),
    appPublicId: text("app_public_id"),
    localBindingId: text("local_binding_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectUnique: uniqueIndex("app_builder_apps_project_uq")
      .on(table.projectId)
      .where(sql`${table.projectId} is not null`),
    orgSourceRootUnique: uniqueIndex("app_builder_apps_org_source_root_uq").on(
      table.orgId,
      table.sourceRoot,
    ),
    orgStatusUpdatedIdx: index("app_builder_apps_org_status_updated_idx").on(
      table.orgId,
      table.buildStatus,
      table.updatedAt,
    ),
    installationAppPublicUnique: uniqueIndex("app_builder_apps_installation_public_uq")
      .on(table.desktopInstallationId, table.appPublicId)
      .where(
        sql`${table.desktopInstallationId} is not null and ${table.appPublicId} is not null`,
      ),
    installationBindingUnique: uniqueIndex("app_builder_apps_installation_binding_uq")
      .on(table.desktopInstallationId, table.localBindingId)
      .where(
        sql`${table.desktopInstallationId} is not null and ${table.localBindingId} is not null`,
      ),
    buildStatusCheck: check(
      "app_builder_apps_build_status_check",
      sql`${table.buildStatus} in ('preparing', 'building', 'verifying', 'ready', 'failed')`,
    ),
    sourceRootCheck: check(
      "app_builder_apps_source_root_check",
      sql`${table.sourceRoot} ~ '^apps/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'`,
    ),
    bindingAllOrNoneCheck: check(
      "app_builder_apps_binding_all_or_none_check",
      sql`(
        (${table.desktopInstallationId} is null and ${table.appPublicId} is null and ${table.localBindingId} is null)
        or
        (${table.desktopInstallationId} is not null and ${table.appPublicId} is not null and ${table.localBindingId} is not null)
      )`,
    ),
  }),
);
