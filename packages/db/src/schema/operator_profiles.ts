import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const operatorProfiles = pgTable(
  "operator_profiles",
  {
    userId: text("user_id").primaryKey(),
    nickname: text("nickname"),
    moreAboutYou: text("more_about_you"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: uniqueIndex("operator_profiles_user_id_idx").on(table.userId),
  }),
);
