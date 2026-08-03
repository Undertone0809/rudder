import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const productAnalyticsCollectorInstallations = pgTable(
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
    installationUniqueIdx: uniqueIndex("product_analytics_collector_installation_uq").on(table.installationId),
  }),
);
