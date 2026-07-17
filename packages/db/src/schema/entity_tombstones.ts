import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const entityTombstones = pgTable(
  "entity_tombstones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    title: text("title").notNull(),
    issueNumber: integer("issue_number"),
    deletedByActorType: text("deleted_by_actor_type").notNull(),
    deletedByActorId: text("deleted_by_actor_id").notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    entityUnique: uniqueIndex("entity_tombstones_entity_uq").on(table.entityType, table.entityId),
    orgDeletedIdx: index("entity_tombstones_org_deleted_idx").on(table.orgId, table.deletedAt),
    issueNumberIdx: index("entity_tombstones_issue_number_idx").on(
      table.orgId,
      table.entityType,
      table.issueNumber,
    ),
  }),
);
