import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { chatConversations } from "./chat_conversations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";
import { nativeSegments, runtimeBindings } from "./runtime_bindings.js";

/**
 * A durable claim that keeps a provider resource readable until all product
 * consumers release it. It contains no transcript payload.
 */
export const runtimeRetentionClaims = pgTable(
  "runtime_retention_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").references(() => runtimeBindings.id, { onDelete: "no action" }),
    segmentId: uuid("segment_id").references(() => nativeSegments.id, { onDelete: "no action" }),
    resourceRef: text("resource_ref").notNull(),
    purpose: text("purpose").notNull(),
    principalScopeRef: text("principal_scope_ref").notNull(),
    readOnly: boolean("read_only").notNull().default(true),
    lifecycleVersion: integer("lifecycle_version").notNull().default(1),
    cleanupEpoch: integer("cleanup_epoch").notNull().default(0),
    status: text("status").$type<"active" | "released" | "expired">().notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgResourcePurposeUnique: uniqueIndex("runtime_retention_claims_org_resource_purpose_uq")
      .on(table.orgId, table.resourceRef, table.purpose)
      .where(sql`${table.status} = 'active'`),
    orgResourceIdx: index("runtime_retention_claims_org_resource_idx").on(table.orgId, table.resourceRef),
    expiryIdx: index("runtime_retention_claims_expiry_idx").on(table.status, table.expiresAt, table.cleanupEpoch),
    lifecycleVersionCheck: check(
      "runtime_retention_claims_lifecycle_version_check",
      sql`${table.lifecycleVersion} > 0 and ${table.cleanupEpoch} >= 0`,
    ),
    statusCheck: check("runtime_retention_claims_status_check", sql`${table.status} in ('active', 'released', 'expired')`),
    lifecycleCheck: check(
      "runtime_retention_claims_lifecycle_check",
      sql`(
        (${table.status} = 'active' and ${table.releasedAt} is null)
        or (${table.status} = 'released' and ${table.releasedAt} is not null)
        or (${table.status} = 'expired' and ${table.expiresAt} is not null and ${table.releasedAt} is null)
      )`,
    ),
    timestampOrderCheck: check(
      "runtime_retention_claims_timestamp_order_check",
      sql`(
        (${table.expiresAt} is null or ${table.expiresAt} >= ${table.createdAt})
        and (${table.releasedAt} is null or ${table.releasedAt} >= ${table.createdAt})
      )`,
    ),
    orgBindingFk: foreignKey({
      name: "runtime_retention_claims_org_binding_fk",
      columns: [table.orgId, table.bindingId],
      foreignColumns: [runtimeBindings.orgId, runtimeBindings.id],
    }).onDelete("no action"),
    orgSegmentFk: foreignKey({
      name: "runtime_retention_claims_org_segment_fk",
      columns: [table.orgId, table.segmentId],
      foreignColumns: [nativeSegments.orgId, nativeSegments.id],
    }).onDelete("no action"),
  }),
);

/**
 * A read-only alias for a product object or copied branch. The exact range
 * and content hash make a displayed fork auditable without copying provider
 * transcript rows into Rudder.
 */
export const runtimeSourceAliases = pgTable(
  "runtime_source_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => chatConversations.id, { onDelete: "no action" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "no action" }),
    bindingId: uuid("binding_id").references(() => runtimeBindings.id, { onDelete: "no action" }),
    segmentId: uuid("segment_id").references(() => nativeSegments.id, { onDelete: "no action" }),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    sourceRangeJson: jsonb("source_range_json").$type<Record<string, unknown>>().notNull().default({}),
    contentSha256: text("content_sha256"),
    principalScopeRef: text("principal_scope_ref").notNull(),
    readOnly: boolean("read_only").notNull().default(true),
    lifecycleVersion: integer("lifecycle_version").notNull().default(1),
    cleanupEpoch: integer("cleanup_epoch").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgSourceIdx: index("runtime_source_aliases_org_source_idx").on(table.orgId, table.sourceKind, table.sourceRef),
    orgConversationIdx: index("runtime_source_aliases_org_conversation_idx").on(table.orgId, table.conversationId),
    orgRunIdx: index("runtime_source_aliases_org_run_idx").on(table.orgId, table.runId),
    cleanupIdx: index("runtime_source_aliases_cleanup_idx").on(table.orgId, table.cleanupEpoch, table.releasedAt),
    lifecycleVersionCheck: check(
      "runtime_source_aliases_lifecycle_version_check",
      sql`${table.lifecycleVersion} > 0 and ${table.cleanupEpoch} >= 0`,
    ),
    timestampOrderCheck: check(
      "runtime_source_aliases_timestamp_order_check",
      sql`(
        (${table.expiresAt} is null or ${table.expiresAt} >= ${table.createdAt})
        and (${table.releasedAt} is null or ${table.releasedAt} >= ${table.createdAt})
      )`,
    ),
    readOnlyCheck: check(
      "runtime_source_aliases_read_only_check",
      sql`${table.readOnly} = true`,
    ),
    orgConversationFk: foreignKey({
      name: "runtime_source_aliases_org_conversation_fk",
      columns: [table.orgId, table.conversationId],
      foreignColumns: [chatConversations.orgId, chatConversations.id],
    }).onDelete("no action"),
    orgRunFk: foreignKey({
      name: "runtime_source_aliases_org_run_fk",
      columns: [table.orgId, table.runId],
      foreignColumns: [heartbeatRuns.orgId, heartbeatRuns.id],
    }).onDelete("no action"),
    orgBindingFk: foreignKey({
      name: "runtime_source_aliases_org_binding_fk",
      columns: [table.orgId, table.bindingId],
      foreignColumns: [runtimeBindings.orgId, runtimeBindings.id],
    }).onDelete("no action"),
    orgSegmentFk: foreignKey({
      name: "runtime_source_aliases_org_segment_fk",
      columns: [table.orgId, table.segmentId],
      foreignColumns: [nativeSegments.orgId, nativeSegments.id],
    }).onDelete("no action"),
  }),
);
