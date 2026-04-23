import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    status: text("status").notNull().default("active"),
    membershipRole: text("membership_role"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationPrincipalUniqueIdx: uniqueIndex("organization_memberships_org_principal_unique_idx").on(
      table.orgId,
      table.principalType,
      table.principalId,
    ),
    principalStatusIdx: index("organization_memberships_principal_status_idx").on(
      table.principalType,
      table.principalId,
      table.status,
    ),
    organizationStatusIdx: index("organization_memberships_org_status_idx").on(table.orgId, table.status),
  }),
);
