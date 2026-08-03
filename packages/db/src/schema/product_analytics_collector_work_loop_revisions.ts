import { boolean, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const productAnalyticsCollectorWorkLoopRevisions = pgTable(
  "product_analytics_collector_work_loop_revisions",
  {
    installationId: text("installation_id").notNull(),
    analyticsSubject: text("analytics_subject"),
    pseudonymousOrgId: text("pseudonymous_org_id"),
    pseudonymousWorkCycleId: text("pseudonymous_work_cycle_id").notNull(),
    completionRevision: integer("completion_revision").notNull(),
    completionEventId: text("completion_event_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReasonCode: text("invalidation_reason_code"),
    invalidationEventId: text("invalidation_event_id"),
    environment: text("environment").notNull(),
    releaseChannel: text("release_channel").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    confidence: text("confidence").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cycleRevisionUniqueIdx: uniqueIndex("product_analytics_collector_work_loop_revision_uq").on(table.installationId, table.pseudonymousWorkCycleId, table.completionRevision),
  }),
);
