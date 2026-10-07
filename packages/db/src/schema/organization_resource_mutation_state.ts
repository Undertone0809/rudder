import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

/** Per-resource ownership and replay fence; resource identity survives catalog deletion. */
export const organizationResourceMutationState = pgTable(
  "organization_resource_mutation_state",
  {
    resourceId: uuid("resource_id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    owner: text("owner").$type<"node" | "rust">().notNull().default("node"),
    mutationVersion: bigint("mutation_version", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceEpoch: bigint("fence_epoch", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    fenceToken: uuid("fence_token")
      .notNull()
      .default(sql`gen_random_uuid()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    versionCheck: check(
      "organization_resource_mutation_state_version_ck",
      sql`${table.mutationVersion} >= 0`,
    ),
    fenceCheck: check(
      "organization_resource_mutation_state_fence_ck",
      sql`${table.fenceEpoch} >= 0`,
    ),
    ownerCheck: check(
      "organization_resource_mutation_state_owner_ck",
      sql`${table.owner} in ('node', 'rust') and (${table.owner} = 'node' or ${table.fenceEpoch} > 0)`,
    ),
  }),
);
