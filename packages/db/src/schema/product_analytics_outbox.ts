import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { productAnalyticsEvents } from "./product_analytics_events.js";

export const productAnalyticsOutbox = pgTable(
  "product_analytics_outbox",
  {
    eventId: uuid("event_id").primaryKey().references(() => productAnalyticsEvents.id),
    installationId: text("installation_id").notNull().default("unknown"),
    deliveryMode: text("delivery_mode").notNull(),
    consentScope: text("consent_scope").notNull(),
    consentedLocalUserId: text("consented_local_user_id"),
    consentVersion: text("consent_version").notNull(),
    consentEpoch: integer("consent_epoch").notNull().default(0),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("product_analytics_outbox_claim_idx").on(table.state, table.nextAttemptAt),
    consentIdx: index("product_analytics_outbox_consent_idx").on(table.deliveryMode, table.consentedLocalUserId, table.consentEpoch),
  }),
);
