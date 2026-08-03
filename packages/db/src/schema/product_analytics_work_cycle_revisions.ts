import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const productAnalyticsWorkCycleRevisions = pgTable(
  "product_analytics_work_cycle_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    workCycleId: text("work_cycle_id").notNull(),
    completionRevision: integer("completion_revision").notNull(),
    completionEventId: uuid("completion_event_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReasonCode: text("invalidation_reason_code"),
    invalidationEventId: uuid("invalidation_event_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cycleRevisionUniqueIdx: uniqueIndex("product_analytics_work_cycle_revision_uq").on(table.orgId, table.workCycleId, table.completionRevision),
    orgCompletedIdx: index("product_analytics_work_cycle_revision_completed_idx").on(table.orgId, table.completedAt),
  }),
);
