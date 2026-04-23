import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";
import { organizationSecrets } from "./organization_secrets.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    parentIssueId: uuid("parent_issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    assigneeAgentId: uuid("assignee_agent_id").notNull().references(() => agents.id),
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("active"),
    concurrencyPolicy: text("concurrency_policy").notNull().default("coalesce_if_active"),
    catchUpPolicy: text("catch_up_policy").notNull().default("skip_missed"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("automations_company_status_idx").on(table.orgId, table.status),
    companyAssigneeIdx: index("automations_company_assignee_idx").on(table.orgId, table.assigneeAgentId),
    companyProjectIdx: index("automations_company_project_idx").on(table.orgId, table.projectId),
  }),
);

export const automationTriggers = pgTable(
  "automation_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label"),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    timezone: text("timezone"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    publicId: text("public_id"),
    secretId: uuid("secret_id").references(() => organizationSecrets.id, { onDelete: "set null" }),
    signingMode: text("signing_mode"),
    replayWindowSec: integer("replay_window_sec"),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    lastResult: text("last_result"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAutomationIdx: index("automation_triggers_company_automation_idx").on(table.orgId, table.automationId),
    companyKindIdx: index("automation_triggers_company_kind_idx").on(table.orgId, table.kind),
    nextRunIdx: index("automation_triggers_next_run_idx").on(table.nextRunAt),
    publicIdIdx: index("automation_triggers_public_id_idx").on(table.publicId),
    publicIdUq: uniqueIndex("automation_triggers_public_id_uq").on(table.publicId),
  }),
);

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
    triggerId: uuid("trigger_id").references(() => automationTriggers.id, { onDelete: "set null" }),
    source: text("source").notNull(),
    status: text("status").notNull().default("received"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key"),
    triggerPayload: jsonb("trigger_payload").$type<Record<string, unknown>>(),
    linkedIssueId: uuid("linked_issue_id").references(() => issues.id, { onDelete: "set null" }),
    coalescedIntoRunId: uuid("coalesced_into_run_id"),
    failureReason: text("failure_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAutomationIdx: index("automation_runs_company_automation_idx").on(table.orgId, table.automationId, table.createdAt),
    triggerIdx: index("automation_runs_trigger_idx").on(table.triggerId, table.createdAt),
    linkedIssueIdx: index("automation_runs_linked_issue_idx").on(table.linkedIssueId),
    idempotencyIdx: index("automation_runs_trigger_idempotency_idx").on(table.triggerId, table.idempotencyKey),
  }),
);
