import { date, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const productAnalyticsCollectorPrivacyAggregates = pgTable(
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
    aggregateUniqueIdx: uniqueIndex("product_analytics_collector_privacy_aggregate_uq").on(table.day, table.metricName, table.dimensionSetVersion, table.dimensionHash),
  }),
);
