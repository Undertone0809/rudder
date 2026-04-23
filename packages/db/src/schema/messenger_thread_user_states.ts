import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const messengerThreadUserStates = pgTable(
  "messenger_thread_user_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    threadKey: text("thread_key").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserIdx: index("messenger_thread_user_states_org_user_idx").on(table.orgId, table.userId),
    orgThreadIdx: index("messenger_thread_user_states_org_thread_idx").on(table.orgId, table.threadKey),
    orgThreadUserUnique: uniqueIndex("messenger_thread_user_states_org_thread_user_idx").on(
      table.orgId,
      table.threadKey,
      table.userId,
    ),
  }),
);
