import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const agentTaskSessions = pgTable(
  "agent_task_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    agentRuntimeType: text("agent_runtime_type").notNull(),
    taskKey: text("task_key").notNull(),
    sessionParamsJson: jsonb("session_params_json").$type<Record<string, unknown>>(),
    sessionDisplayId: text("session_display_id"),
    lastRunId: uuid("last_run_id").references(() => heartbeatRuns.id),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentTaskUniqueIdx: uniqueIndex("agent_task_sessions_company_agent_adapter_task_uniq").on(
      table.orgId,
      table.agentId,
      table.agentRuntimeType,
      table.taskKey,
    ),
    companyAgentUpdatedIdx: index("agent_task_sessions_company_agent_updated_idx").on(
      table.orgId,
      table.agentId,
      table.updatedAt,
    ),
    companyTaskUpdatedIdx: index("agent_task_sessions_company_task_updated_idx").on(
      table.orgId,
      table.taskKey,
      table.updatedAt,
    ),
  }),
);
