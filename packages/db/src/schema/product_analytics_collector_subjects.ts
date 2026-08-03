import { integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const productAnalyticsCollectorSubjects = pgTable(
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
