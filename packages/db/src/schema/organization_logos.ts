import { pgTable, uuid, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { assets } from "./assets.js";

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
