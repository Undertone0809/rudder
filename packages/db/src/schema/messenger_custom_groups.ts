import { boolean, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const messengerCustomGroups = pgTable(
  "messenger_custom_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    collapsed: boolean("collapsed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserIdx: index("messenger_custom_groups_org_user_idx").on(table.orgId, table.userId),
    orgUserOrderIdx: index("messenger_custom_groups_org_user_order_idx").on(table.orgId, table.userId, table.sortOrder),
    orgUserIdUnique: unique("messenger_custom_groups_org_user_id_unique").on(table.orgId, table.userId, table.id),
  }),
);

export const messengerCustomGroupEntries = pgTable(
  "messenger_custom_group_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    groupId: uuid("group_id").notNull(),
    threadKey: text("thread_key").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerGroupFk: foreignKey({
      columns: [table.orgId, table.userId, table.groupId],
      foreignColumns: [messengerCustomGroups.orgId, messengerCustomGroups.userId, messengerCustomGroups.id],
      name: "messenger_custom_group_entries_owner_group_fk",
    }).onDelete("cascade"),
    orgUserGroupIdx: index("messenger_custom_group_entries_org_user_group_idx").on(table.orgId, table.userId, table.groupId, table.sortOrder),
    orgUserThreadUnique: uniqueIndex("messenger_custom_group_entries_org_user_thread_idx").on(table.orgId, table.userId, table.threadKey),
  }),
);
