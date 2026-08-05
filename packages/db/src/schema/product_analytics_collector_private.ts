import { boolean, date, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Tables owned by the central telemetry deployment. Keeping these in a
 * separate schema makes it possible to grant the collector and reporting
 * roles different capabilities from the local Rudder application.
 */
export const rudderAnalyticsSchema = pgSchema("rudder_analytics");

export const privateProductAnalyticsCollectorEvents = rudderAnalyticsSchema.table(
  "product_analytics_collector_events",
  {
    eventId: uuid("event_id").primaryKey(),
    installationId: text("installation_id").notNull(),
    analyticsSubject: text("analytics_subject"),
    eventName: text("event_name").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    environment: text("environment").notNull(),
    appVersion: text("app_version").notNull(),
    releaseChannel: text("release_channel").notNull(),
    deploymentMode: text("deployment_mode").notNull(),
    coarsePlatform: text("coarse_platform"),
    actorKind: text("actor_kind").notNull(),
    origin: text("origin").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    pseudonymousInstallationId: text("pseudonymous_installation_id"),
    pseudonymousOrgId: text("pseudonymous_org_id"),
    pseudonymousWorkId: text("pseudonymous_work_id"),
    pseudonymousWorkCycleId: text("pseudonymous_work_cycle_id"),
    pseudonymousRootRunId: text("pseudonymous_root_run_id"),
    pseudonymousRunId: text("pseudonymous_run_id"),
    completionRevision: integer("completion_revision"),
    properties: jsonb("properties").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    confidence: text("confidence").notNull(),
    isBackfill: boolean("is_backfill").notNull().default(false),
    late: boolean("late").notNull().default(false),
    consentVersion: text("consent_version").notNull(),
    consentEpoch: integer("consent_epoch").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
  },
  (table) => ({
    installationOccurredIdx: index("rudder_analytics_events_installation_occurred_idx").on(table.installationId, table.occurredAt),
    eventOccurredIdx: index("rudder_analytics_events_event_occurred_idx").on(table.eventName, table.occurredAt),
    subjectOccurredIdx: index("rudder_analytics_events_subject_occurred_idx").on(table.analyticsSubject, table.occurredAt),
  }),
);

export const privateProductAnalyticsCollectorQualityCounters = rudderAnalyticsSchema.table(
  "product_analytics_collector_quality_counters",
  {
    day: date("day").primaryKey(),
    receivedBatches: integer("received_batches").notNull().default(0),
    acceptedEvents: integer("accepted_events").notNull().default(0),
    duplicateEvents: integer("duplicate_events").notNull().default(0),
    rejectedEvents: integer("rejected_events").notNull().default(0),
    lateEvents: integer("late_events").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const privateProductAnalyticsCollectorInstallations = rudderAnalyticsSchema.table(
  "product_analytics_collector_installations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: text("installation_id").notNull(),
    mode: text("mode").notNull().default("anonymous"),
    consentVersion: text("consent_version").notNull(),
    consentEpoch: integer("consent_epoch").notNull(),
    analyticsSubject: text("analytics_subject"),
    revoked: boolean("revoked").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    installationUniqueIdx: uniqueIndex("rudder_analytics_installation_uq").on(table.installationId),
  }),
);

export const privateProductAnalyticsCollectorSubjects = rudderAnalyticsSchema.table(
  "product_analytics_collector_subjects",
  {
    installationId: text("installation_id").notNull(),
    analyticsSubject: text("analytics_subject").notNull(),
    consentVersion: text("consent_version").notNull(),
    consentEpoch: integer("consent_epoch").notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectPk: primaryKey({ columns: [table.installationId, table.analyticsSubject] }),
  }),
);

export const privateProductAnalyticsCollectorDailyRollups = rudderAnalyticsSchema.table(
  "product_analytics_collector_daily_rollups",
  {
    day: date("day").notNull(),
    installationId: text("installation_id").notNull(),
    eventName: text("event_name").notNull(),
    origin: text("origin").notNull(),
    dimensionHash: text("dimension_hash").notNull(),
    dimensions: jsonb("dimensions").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    eventCount: integer("event_count").notNull().default(0),
    firstOccurredAt: timestamp("first_occurred_at", { withTimezone: true }).notNull(),
    lastOccurredAt: timestamp("last_occurred_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rollupUniqueIdx: uniqueIndex("rudder_analytics_daily_rollup_uq").on(table.day, table.installationId, table.eventName, table.origin, table.dimensionHash),
  }),
);

export const privateProductAnalyticsCollectorPrivacyAggregates = rudderAnalyticsSchema.table(
  "product_analytics_collector_privacy_aggregates",
  {
    day: date("day").notNull(),
    metricName: text("metric_name").notNull(),
    dimensionSetVersion: integer("dimension_set_version").notNull().default(1),
    dimensionHash: text("dimension_hash").notNull(),
    dimensionValues: jsonb("dimension_values").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    metricValue: integer("metric_value").notNull().default(0),
    contributingInstallations: integer("contributing_installations").notNull().default(0),
    privacyThreshold: integer("privacy_threshold").notNull().default(10),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    aggregateUniqueIdx: uniqueIndex("rudder_analytics_privacy_aggregate_uq").on(table.day, table.metricName, table.dimensionSetVersion, table.dimensionHash),
  }),
);

export const privateProductAnalyticsCollectorWorkLoopRevisions = rudderAnalyticsSchema.table(
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
    origin: text("origin").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    confidence: text("confidence").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cycleRevisionUniqueIdx: uniqueIndex("rudder_analytics_work_loop_revision_uq").on(table.installationId, table.pseudonymousWorkCycleId, table.completionRevision),
  }),
);
