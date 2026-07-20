import type { MessengerSavedViewTarget, MessengerSavedViewTargetKind } from "@rudderhq/shared";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const messengerSavedViews = pgTable(
  "messenger_saved_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    targetKind: text("target_kind").$type<MessengerSavedViewTargetKind>().notNull(),
    targetPayload: jsonb("target_payload").$type<MessengerSavedViewTarget>().notNull(),
    resourceKey: text("resource_key").notNull(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    favicon: text("favicon"),
    sortOrder: integer("sort_order").notNull().default(0),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserResourceUnique: uniqueIndex("messenger_saved_views_org_user_resource_uq")
      .on(table.orgId, table.userId, table.resourceKey),
    orgUserOrderIdx: index("messenger_saved_views_org_user_order_idx")
      .on(table.orgId, table.userId, table.sortOrder, table.createdAt),
    orgUserVisibleOrderIdx: index("messenger_saved_views_org_user_visible_order_idx")
      .on(table.orgId, table.userId, table.sortOrder, table.createdAt)
      .where(sql`${table.hiddenAt} is null`),
  }),
);
