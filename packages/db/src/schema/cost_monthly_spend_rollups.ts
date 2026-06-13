import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const costMonthlySpendRollups = pgTable(
  "cost_monthly_spend_rollups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    spendCents: integer("spend_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeMonthUniqueIdx: uniqueIndex("cost_monthly_spend_rollups_scope_month_uq").on(
      table.orgId,
      table.scopeType,
      table.scopeId,
      table.monthStart,
    ),
    orgMonthIdx: index("cost_monthly_spend_rollups_org_month_idx").on(table.orgId, table.monthStart),
  }),
);
