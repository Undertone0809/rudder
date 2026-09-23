import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { activityLog } from "./activity_log.js";
import { organizations } from "./organizations.js";

/** Private D1 state. Missing state and the default owner both keep Node authoritative. */
export const organizationMutationState = pgTable(
  "organization_mutation_state",
  {
    orgId: uuid("org_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mutationVersion: bigint("mutation_version", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceToken: uuid("fence_token")
      .notNull()
      .default(sql`gen_random_uuid()`),
    owner: text("owner").$type<"node" | "rust">().notNull().default("node"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionCheck: check(
      "organization_mutation_state_version_ck",
      sql`${table.mutationVersion} >= 0`,
    ),
    fenceCheck: check(
      "organization_mutation_state_fence_ck",
      sql`${table.fenceEpoch} >= 0`,
    ),
    ownerCheck: check(
      "organization_mutation_state_owner_ck",
      sql`${table.owner} in ('node', 'rust') and (${table.owner} = 'node' or ${table.fenceEpoch} > 0)`,
    ),
  }),
);

/** Original committed outcomes, never a current-state cache or second writer. */
export const organizationMutationReceipts = pgTable(
  "organization_mutation_receipts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationMutationState.orgId, {
        onDelete: "cascade",
      }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandKind: text("command_kind")
      .$type<
        "organization_branding" | "project_goal_link" | "project_goal_set_replacement"
      >()
      .notNull(),
    commandFingerprint: text("command_fingerprint").notNull(),
    receiptFormat: integer("receipt_format").notNull().default(1),
    outcome: text("outcome").$type<"applied" | "noop">().notNull(),
    resultingVersion: bigint("resulting_version", { mode: "bigint" }).notNull(),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" }).notNull(),
    activityId: uuid("activity_id").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.idempotencyKey] }),
    activityUnique: unique("organization_mutation_receipts_activity_uq").on(
      table.activityId,
    ),
    // The existing Node delete path removes activity before the organization.
    activityFk: foreignKey({
      name: "organization_mutation_receipts_activity_fk",
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
    }).onDelete("no action"),
    keyCheck: check(
      "organization_mutation_receipts_key_ck",
      sql`octet_length(${table.idempotencyKey}) between 1 and 256`,
    ),
    fingerprintCheck: check(
      "organization_mutation_receipts_fingerprint_ck",
      sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    kindCheck: check(
      "organization_mutation_receipts_kind_ck",
      sql`${table.commandKind} in ('organization_branding', 'project_goal_link', 'project_goal_set_replacement')`,
    ),
    outcomeCheck: check(
      "organization_mutation_receipts_outcome_ck",
      sql`${table.outcome} in ('applied', 'noop')`,
    ),
    versionCheck: check(
      "organization_mutation_receipts_version_ck",
      sql`${table.resultingVersion} >= 0 and ${table.fenceEpoch} >= 0 and ${table.receiptFormat} > 0`,
    ),
    resultCheck: check(
      "organization_mutation_receipts_result_ck",
      sql`coalesce(
        jsonb_typeof(${table.result}) = 'object'
        and ${table.result}->>'organization_id' = ${table.orgId}::text
        and ${table.result}->>'version' = ${table.resultingVersion}::text
        and ${table.result}->>'fence_epoch' = ${table.fenceEpoch}::text, false)`,
    ),
  }),
);
