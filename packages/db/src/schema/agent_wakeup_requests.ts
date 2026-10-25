import { sql } from "drizzle-orm";
import { type RuntimeExecutionAuthority } from "@rudderhq/shared";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    /** Queue ownership is fixed when the wakeup is created, before a run exists. */
    executionAuthority: text("execution_authority").$type<RuntimeExecutionAuthority>().notNull().default("legacy_ts"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    delegationIdempotencyKey: text("delegation_idempotency_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    executionAuthorityCheck: check(
      "agent_wakeup_requests_execution_authority_check",
      sql`${table.executionAuthority} in ('legacy_ts', 'native_rust')`,
    ),
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.orgId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.orgId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    companyAgentIdempotencyKeyUniqueIdx: uniqueIndex("agent_wakeup_requests_company_agent_idempotency_key_uq")
      .on(table.orgId, table.agentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    companyDelegationIdempotencyKeyUniqueIdx: uniqueIndex("agent_wakeup_requests_company_delegation_idempotency_key_uq")
      .on(table.orgId, table.delegationIdempotencyKey)
      .where(sql`${table.delegationIdempotencyKey} is not null`),
  }),
);
