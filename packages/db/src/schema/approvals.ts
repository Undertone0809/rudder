import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    /** Monotonic approval revision used by governed decisions. */
    revision: bigint("revision", { mode: "number" }).notNull().default(0),
    /** Explicit decision value; status remains the legacy display/state field. */
    decision: text("decision"),
    /** Nullable until the legacy pending approval receives its first decision. */
    decisionIdempotencyKey: text("decision_idempotency_key"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdUq: uniqueIndex("approvals_org_id_id_uq").on(table.orgId, table.id),
    decisionIdempotencyUq: uniqueIndex("approvals_org_decision_idempotency_uq")
      .on(table.orgId, table.decisionIdempotencyKey)
      .where(sql`${table.decisionIdempotencyKey} is not null`),
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.orgId,
      table.status,
      table.type,
    ),
    companyUpdatedIdx: index("approvals_company_updated_idx").on(
      table.orgId,
      table.updatedAt,
    ),
    companyStatusUpdatedIdx: index("approvals_company_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
  }),
);
