import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const productAnalyticsConsentLedger = pgTable(
  "product_analytics_consent_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: text("installation_id").notNull(),
    scope: text("scope").notNull(),
    localUserId: text("local_user_id"),
    decision: text("decision").notNull(),
    policyVersion: text("policy_version").notNull(),
    consentEpoch: integer("consent_epoch").notNull(),
    decidedByLocalUserId: text("decided_by_local_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    uploadFromAt: timestamp("upload_from_at", { withTimezone: true }),
  },
  (table) => ({
    lookupIdx: index("product_analytics_consent_lookup_idx").on(table.installationId, table.scope, table.localUserId, table.decidedAt),
  }),
);
