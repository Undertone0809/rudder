import { date, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const productAnalyticsCollectorDailyRollups = pgTable(
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
    rollupUniqueIdx: uniqueIndex("product_analytics_collector_daily_rollup_uq").on(table.day, table.installationId, table.eventName, table.origin, table.dimensionHash),
  }),
);
