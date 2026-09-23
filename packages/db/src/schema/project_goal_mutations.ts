import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

/** Project-scoped ownership for the complete project_goals replacement. */
export const projectGoalMutationState = pgTable(
  "project_goal_mutation_state",
  {
    projectId: uuid("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
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
    orgProjectUnique: unique("project_goal_mutation_state_org_project_uq").on(
      table.orgId,
      table.projectId,
    ),
    versionCheck: check(
      "project_goal_mutation_state_version_ck",
      sql`${table.mutationVersion} >= 0`,
    ),
    fenceCheck: check(
      "project_goal_mutation_state_fence_ck",
      sql`${table.fenceEpoch} >= 0`,
    ),
    ownerCheck: check(
      "project_goal_mutation_state_owner_ck",
      sql`${table.owner} in ('node', 'rust') and (${table.owner} = 'node' or ${table.fenceEpoch} > 0)`,
    ),
  }),
);
