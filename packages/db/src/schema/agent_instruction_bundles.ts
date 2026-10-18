import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

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
