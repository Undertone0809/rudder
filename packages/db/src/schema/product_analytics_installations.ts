import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const productAnalyticsInstallations = pgTable("product_analytics_installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  installationId: text("installation_id").notNull().unique(),
  installationSecretHash: text("installation_secret_hash").notNull(),
  mode: text("mode").notNull().default("off"),
  state: jsonb("state").$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
