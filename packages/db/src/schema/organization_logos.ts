import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { assets } from "./assets.js";
import { organizations } from "./organizations.js";

export const organizationLogos = pgTable(
  "organization_logos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationUq: uniqueIndex("organization_logos_org_uq").on(table.orgId),
    assetUq: uniqueIndex("organization_logos_asset_uq").on(table.assetId),
  }),
);
