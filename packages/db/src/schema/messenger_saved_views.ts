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
    instanceId: text("instance_id").notNull(),
    canonicalResourceKey: text("canonical_resource_key").notNull(),
    clientMutationId: uuid("client_mutation_id"),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    favicon: text("favicon"),
    sortOrder: integer("sort_order").notNull().default(0),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    primaryRailPinnedAt: timestamp("primary_rail_pinned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserResourceUnique: uniqueIndex("messenger_saved_views_org_user_resource_uq")
      .on(table.orgId, table.userId, table.resourceKey),
    orgUserInstanceUnique: uniqueIndex("messenger_saved_views_org_user_instance_uq")
      .on(table.orgId, table.userId, table.instanceId),
    orgUserClientMutationUnique: uniqueIndex("messenger_saved_views_org_user_client_mutation_uq")
      .on(table.orgId, table.userId, table.clientMutationId)
      .where(sql`${table.clientMutationId} is not null`),
    orgUserOrderIdx: index("messenger_saved_views_org_user_order_idx")
      .on(table.orgId, table.userId, table.sortOrder, table.createdAt),
    orgUserVisibleOrderIdx: index("messenger_saved_views_org_user_visible_order_idx")
      .on(table.orgId, table.userId, table.sortOrder, table.createdAt)
      .where(sql`${table.hiddenAt} is null`),
    orgUserPrimaryRailPinsIdx: index("messenger_saved_views_org_user_primary_rail_pins_idx")
      .on(table.orgId, table.userId, table.primaryRailPinnedAt)
      .where(sql`${table.primaryRailPinnedAt} is not null`),
  }),
);

/**
 * Durable idempotency receipts for the atomic Saved View Keep operation.
 *
 * Saved-view and group ids deliberately are not foreign keys: receipts must
 * survive deletion so a previously consumed mutation id cannot later be
 * replayed for a different intent.
 */
export const messengerSavedViewMutations = pgTable(
  "messenger_saved_view_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    clientMutationId: uuid("client_mutation_id").notNull(),
    savedViewId: uuid("saved_view_id").notNull(),
    groupId: uuid("group_id"),
    requestFingerprint: text("request_fingerprint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserMutationUnique: uniqueIndex("messenger_saved_view_mutations_org_user_mutation_uq")
      .on(table.orgId, table.userId, table.clientMutationId),
    savedViewIdx: index("messenger_saved_view_mutations_saved_view_idx")
      .on(table.orgId, table.userId, table.savedViewId),
  }),
);
