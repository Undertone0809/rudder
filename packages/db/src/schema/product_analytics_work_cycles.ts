import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const productAnalyticsWorkCycles = pgTable(
  "product_analytics_work_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    workSurface: text("work_surface").notNull(),
    workId: text("work_id").notNull(),
    workCycleId: text("work_cycle_id").notNull(),
    origin: text("origin").notNull().default("human"),
    actorId: text("actor_id"),
    state: text("state").notNull().default("open"),
    completionRevision: integer("completion_revision").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    outputReadyAt: timestamp("output_ready_at", { withTimezone: true }),
    reviewDecision: text("review_decision"),
    rootRunIds: jsonb("root_run_ids").$type<string[]>().notNull().default([]),
    metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgCycleUniqueIdx: uniqueIndex("product_analytics_work_cycles_org_cycle_uq").on(table.orgId, table.workCycleId),
    orgStateIdx: index("product_analytics_work_cycles_org_state_idx").on(table.orgId, table.state),
    orgStartedIdx: index("product_analytics_work_cycles_org_started_idx").on(table.orgId, table.startedAt),
  }),
);
