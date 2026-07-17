import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";

export const entityCleanupJobs = pgTable(
  "entity_cleanup_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    artifactType: text("artifact_type").notNull(),
    artifactRef: text("artifact_ref").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    artifactUnique: uniqueIndex("entity_cleanup_jobs_artifact_uq").on(
      table.orgId,
      table.artifactType,
      table.artifactRef,
    ),
    retryIdx: index("entity_cleanup_jobs_retry_idx").on(table.nextAttemptAt, table.createdAt),
  }),
);
