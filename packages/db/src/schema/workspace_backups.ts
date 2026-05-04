import {
  type AnyPgColumn,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

export const workspaceBackups = pgTable(
  "workspace_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    triggerSource: text("trigger_source").notNull().default("manual"),
    artifactProvider: text("artifact_provider").notNull().default("local_file"),
    artifactRef: text("artifact_ref").notNull(),
    archiveSha256: text("archive_sha256"),
    treeSha256: text("tree_sha256"),
    fileCount: integer("file_count").notNull().default(0),
    byteSize: bigint("byte_size", { mode: "number" }).notNull().default(0),
    compressedSize: bigint("compressed_size", { mode: "number" }).notNull().default(0),
    manifest: jsonb("manifest").$type<Record<string, unknown>>(),
    warnings: jsonb("warnings").$type<string[]>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    restoredFromBackupId: uuid("restored_from_backup_id").references((): AnyPgColumn => workspaceBackups.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCreatedIdx: index("workspace_backups_org_created_idx").on(table.orgId, table.createdAt),
    orgStatusIdx: index("workspace_backups_org_status_idx").on(table.orgId, table.status),
  }),
);
