import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";
import { organizationResources } from "./organization_resources.js";

export const projectResourceAttachments = pgTable(
  "project_resource_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    resourceId: uuid("resource_id").notNull().references(() => organizationResources.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("reference"),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProjectIdx: index("project_resource_attachments_org_project_idx").on(table.orgId, table.projectId),
    resourceIdx: index("project_resource_attachments_resource_idx").on(table.resourceId),
    projectResourceUniqueIdx: uniqueIndex("project_resource_attachments_project_resource_idx").on(
      table.projectId,
      table.resourceId,
    ),
  }),
);

