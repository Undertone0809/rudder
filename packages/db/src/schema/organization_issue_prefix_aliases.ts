import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const organizationIssuePrefixAliases = pgTable(
  "organization_issue_prefix_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    prefixUniqueIdx: uniqueIndex("organization_issue_prefix_aliases_prefix_idx").on(table.prefix),
  }),
);
