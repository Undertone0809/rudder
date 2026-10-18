import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    workspaceKey: text("workspace_key"),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    readinessState: text("readiness_state").notNull().default("unknown"),
    readinessCheckedAt: timestamp("readiness_checked_at", { withTimezone: true }),
    readinessResultCode: text("readiness_result_code"),
    capabilities: text("capabilities"),
    agentRuntimeType: text("agent_runtime_type").notNull().default("process"),
    agentRuntimeConfig: jsonb("agent_runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdUq: uniqueIndex("agents_org_id_uq").on(table.orgId, table.id),
    companyStatusIdx: index("agents_company_status_idx").on(table.orgId, table.status),
    companyWorkspaceKeyIdx: uniqueIndex("agents_org_workspace_key_idx").on(table.orgId, table.workspaceKey),
  }),
);

/**
 * Private Agent-create instruction outbox. The row is the desired bundle;
 * host files are only a projection and may be repaired after a process crash.
 */
export const agentInstructionBundles = pgTable(
  "agent_instruction_bundles",
  {
    agentId: uuid("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    entryFile: text("entry_file").notNull(),
    files: jsonb("files").$type<Record<string, string>>().notNull(),
    clearLegacyPromptTemplate: boolean("clear_legacy_prompt_template").notNull().default(false),
    state: text("state").$type<"pending" | "repair" | "materialized">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    materializedAt: timestamp("materialized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("agent_instruction_bundles_claim_idx").on(
      table.state,
      table.nextAttemptAt,
      table.createdAt,
    ),
    stateCheck: check(
      "agent_instruction_bundles_state_ck",
      sql`${table.state} in ('pending', 'repair', 'materialized') and ${table.attempts} >= 0`,
    ),
    entryCheck: check(
      "agent_instruction_bundles_entry_ck",
      sql`octet_length(${table.entryFile}) between 1 and 512 and left(${table.entryFile}, 1) <> '/'`,
    ),
    filesCheck: check(
      "agent_instruction_bundles_files_ck",
      sql`jsonb_typeof(${table.files}) = 'object'`,
    ),
  }),
);
