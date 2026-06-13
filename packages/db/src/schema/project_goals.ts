import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { goals } from "./goals.js";
import { organizations } from "./organizations.js";
import { projects } from "./projects.js";

export const projectGoals = pgTable(
  "project_goals",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.goalId] }),
    projectIdx: index("project_goals_project_idx").on(table.projectId),
    goalIdx: index("project_goals_goal_idx").on(table.goalId),
    orgIdx: index("project_goals_company_idx").on(table.orgId),
  }),
);
