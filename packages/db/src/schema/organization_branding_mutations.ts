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

/**
 * The scalar brand-color component has its own authority fence. It must not
 * share the organization-wide fence used by Project, portability, or other
 * legacy organization writers.
 */
export const organizationBrandingMutationState = pgTable(
  "organization_branding_mutation_state",
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
      "organization_branding_mutation_state_version_ck",
      sql`${table.mutationVersion} >= 0`,
    ),
    fenceCheck: check(
      "organization_branding_mutation_state_fence_ck",
      sql`${table.fenceEpoch} >= 0`,
    ),
    ownerCheck: check(
      "organization_branding_mutation_state_owner_ck",
      sql`${table.owner} in ('node', 'rust') and (${table.owner} = 'node' or ${table.fenceEpoch} > 0)`,
    ),
  }),
);

/** Durable scalar-brand-color outcomes, separate from the organization-wide D1 receipts. */
export const organizationBrandingMutationReceipts = pgTable(
  "organization_branding_mutation_receipts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizationBrandingMutationState.orgId, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
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
    activityUnique: unique("organization_branding_mutation_receipts_activity_uq").on(
      table.activityId,
    ),
    activityFk: foreignKey({
      name: "organization_branding_mutation_receipts_activity_fk",
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
    }).onDelete("no action"),
    keyCheck: check(
      "organization_branding_mutation_receipts_key_ck",
      sql`octet_length(${table.idempotencyKey}) between 1 and 256`,
    ),
    fingerprintCheck: check(
      "organization_branding_mutation_receipts_fingerprint_ck",
      sql`${table.commandFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    outcomeCheck: check(
      "organization_branding_mutation_receipts_outcome_ck",
      sql`${table.outcome} in ('applied', 'noop')`,
    ),
    versionCheck: check(
      "organization_branding_mutation_receipts_version_ck",
      sql`${table.resultingVersion} >= 0 and ${table.fenceEpoch} >= 0 and ${table.receiptFormat} > 0`,
    ),
    resultCheck: check(
      "organization_branding_mutation_receipts_result_ck",
      sql`coalesce(
        jsonb_typeof(${table.result}) = 'object'
        and ${table.result}->>'organization_id' = ${table.orgId}::text
        and ${table.result}->>'version' = ${table.resultingVersion}::text
        and ${table.result}->>'fence_epoch' = ${table.fenceEpoch}::text, false)`,
    ),
  }),
);

/**
 * Post-commit delivery queue for activity live events. The row is written by
 * the Rust business transaction and published by the existing event transport
 * with retryable recovery after a process interruption.
 */
export const organizationMutationOutbox = pgTable(
  "organization_mutation_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: text("state").$type<"pending" | "published">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    activityUnique: unique("organization_mutation_outbox_activity_uq").on(table.activityId),
    activityFk: foreignKey({
      name: "organization_mutation_outbox_activity_fk",
      columns: [table.orgId, table.activityId],
      foreignColumns: [activityLog.orgId, activityLog.id],
    }).onDelete("no action"),
    stateCheck: check(
      "organization_mutation_outbox_state_ck",
      sql`${table.state} in ('pending', 'published') and ${table.attempts} >= 0`,
    ),
    payloadCheck: check(
      "organization_mutation_outbox_payload_ck",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);
