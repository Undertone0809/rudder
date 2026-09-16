import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { organizations } from "./organizations.js";

/**
 * Dormant D1 ownership metadata, not permission to start a second writer.
 * Legacy Node writers do not consume this table. A future reviewed handoff must
 * stop/drain them before advancing the fence and selecting a Rust owner.
 * No production caller provisions or changes ownership in this slice.
 */
export const organizationMutationAuthorities = pgTable(
  "organization_mutation_authorities",
  {
    orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
    mutationVersion: bigint("mutation_version", { mode: "bigint" }).notNull().default(sql`0`),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" }).notNull().default(sql`0`),
    writerOwner: text("writer_owner").notNull().default("node"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("org_mutation_authority_version_nonnegative", sql`${table.mutationVersion} >= 0`),
    check("org_mutation_authority_fence_nonnegative", sql`${table.fenceEpoch} >= 0`),
    check("org_mutation_authority_owner_valid", sql`${table.writerOwner} in ('node', 'rust_d1')`),
  ],
);

/**
 * Immutable original results; replay never substitutes a later aggregate state.
 * All D1 commands share the organization/key namespace. The activity foreign
 * key is made DEFERRABLE INITIALLY DEFERRED by the companion migration fragment:
 * this preserves activity-first organization deletion without allowing an
 * audit-only deletion to silently erase a durable idempotency receipt.
 */
export const organizationMutationReceipts = pgTable(
  "organization_mutation_receipts",
  {
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    commandKind: text("command_kind").notNull(),
    commandFingerprint: text("command_fingerprint").notNull(),
    expectedVersion: bigint("expected_version", { mode: "bigint" }).notNull(),
    resultingVersion: bigint("resulting_version", { mode: "bigint" }).notNull(),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" }).notNull(),
    resultingFenceEpoch: bigint("resulting_fence_epoch", { mode: "bigint" }).notNull(),
    outcomeKind: text("outcome_kind").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    activityId: uuid("activity_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "org_mutation_receipts_org_key_pk", columns: [table.orgId, table.idempotencyKey] }),
    uniqueIndex("org_mutation_receipts_org_activity_uq").on(table.orgId, table.activityId),
    foreignKey({
      name: "org_mutation_receipts_org_activity_fk",
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
    }),
    check("org_mutation_receipts_key_valid", sql`octet_length(${table.idempotencyKey}) between 1 and 256`),
    check("org_mutation_receipts_schema_valid", sql`${table.schemaVersion} = 1`),
    check("org_mutation_receipts_command_valid", sql`${table.commandKind} in ('organization_branding', 'project_goal_link')`),
    check("org_mutation_receipts_fingerprint_valid", sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`),
    check("org_mutation_receipts_versions_valid", sql`${table.expectedVersion} >= 0 and ${table.resultingVersion} >= ${table.expectedVersion}`),
    check("org_mutation_receipts_fences_valid", sql`${table.fenceEpoch} >= 0 and ${table.resultingFenceEpoch} = ${table.fenceEpoch}`),
    check("org_mutation_receipts_outcome_valid", sql`(
      ${table.outcomeKind} = 'applied' and ${table.resultingVersion} - ${table.expectedVersion} = 1
    ) or (
      ${table.outcomeKind} = 'noop' and ${table.resultingVersion} = ${table.expectedVersion}
    )`),
    check("org_mutation_receipts_result_object", sql`jsonb_typeof(${table.result}) = 'object'`),
  ],
);
