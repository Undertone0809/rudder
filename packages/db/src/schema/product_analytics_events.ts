import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const productAnalyticsEvents = pgTable(
  "product_analytics_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    eventName: text("event_name").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    sourceTransition: text("source_transition").notNull(),
    confidence: text("confidence").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    dedupeKey: text("dedupe_key").notNull(),
    properties: jsonb("properties").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  },
  (table) => ({
    orgOccurredIdx: index("product_analytics_events_org_occurred_idx").on(table.orgId, table.occurredAt),
    orgEventOccurredIdx: index("product_analytics_events_org_event_occurred_idx").on(
      table.orgId,
      table.eventName,
      table.occurredAt,
    ),
    orgActorOccurredIdx: index("product_analytics_events_org_actor_occurred_idx").on(
      table.orgId,
      table.actorType,
      table.actorId,
      table.occurredAt,
    ),
    orgDedupeKeyUniqueIdx: uniqueIndex("product_analytics_events_org_dedupe_key_uq").on(table.orgId, table.dedupeKey),
  }),
);
