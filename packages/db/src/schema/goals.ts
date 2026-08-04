import { sql } from "drizzle-orm";
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description"),
    /** Canonical Goal Contract fields. Legacy hierarchy/status columns remain for migration reads. */
    outcomeStatement: text("outcome_statement"),
    objectiveMode: text("objective_mode").notNull().default("target"),
    lifecycle: text("lifecycle").notNull().default("draft"),
    contractRevision: integer("contract_revision").notNull().default(1),
    criteria: jsonb("criteria").$type<unknown[]>().notNull().default([]),
    autonomyEnvelope: jsonb("autonomy_envelope").$type<Record<string, unknown>>().notNull().default({}),
    humanAuthorities: jsonb("human_authorities").$type<Record<string, unknown>>().notNull().default({}),
    evaluationPolicy: jsonb("evaluation_policy").$type<Record<string, unknown>>().notNull().default({}),
    actionDeadline: timestamp("action_deadline", { withTimezone: true }),
    evaluationDeadline: timestamp("evaluation_deadline", { withTimezone: true }),
    evaluationResult: jsonb("evaluation_result").$type<Record<string, unknown> | null>(),
    closeReason: text("close_reason"),
    resultPayload: jsonb("result_payload").$type<Record<string, unknown> | null>(),
    focus: boolean("focus").notNull().default(false),
    planRevision: integer("plan_revision").notNull().default(0),
    continuationKind: text("continuation_kind"),
    continuationSummary: text("continuation_summary"),
    wakeCondition: text("wake_condition"),
    level: text("level").notNull().default("task"),
    status: text("status").notNull().default("planned"),
    parentId: uuid("parent_id").references((): AnyPgColumn => goals.id),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("goals_company_idx").on(table.orgId),
    orgFocusIdx: uniqueIndex("goals_org_focus_uq")
      .on(table.orgId)
      .where(sql`${table.focus} = true`),
  }),
);

export const goalOwnerAssignments = pgTable(
  "goal_owner_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    assignmentRevision: integer("assignment_revision").notNull().default(1),
    assignedByAuthorityRef: text("assigned_by_authority_ref"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalIdx: index("goal_owner_assignments_goal_idx").on(table.goalId, table.startsAt),
    currentGoalUq: uniqueIndex("goal_owner_assignments_current_goal_uq")
      .on(table.goalId)
      .where(sql`${table.endsAt} is null`),
  }),
);

export const goalPlans = pgTable(
  "goal_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    summary: text("summary").notNull(),
    hypotheses: jsonb("hypotheses").$type<unknown[]>().notNull().default([]),
    selectedPaths: jsonb("selected_paths").$type<unknown[]>().notNull().default([]),
    rejectedPaths: jsonb("rejected_paths").$type<unknown[]>().notNull().default([]),
    sequencing: jsonb("sequencing").$type<unknown[]>().notNull().default([]),
    budgetAllocations: jsonb("budget_allocations").$type<Record<string, unknown>>().notNull().default({}),
    invalidationConditions: jsonb("invalidation_conditions").$type<unknown[]>().notNull().default([]),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalRevisionUq: uniqueIndex("goal_plans_goal_revision_uq").on(table.goalId, table.revision),
    goalRevisionIdx: index("goal_plans_goal_revision_idx").on(table.goalId, table.revision),
  }),
);

export const goalActivities = pgTable(
  "goal_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    contractRevision: integer("contract_revision").notNull(),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    agentOwnerRefAtTime: uuid("agent_owner_ref_at_time").references(() => agents.id, { onDelete: "set null" }),
    commitmentRef: text("commitment_ref"),
    runRef: uuid("run_ref"),
    activityKind: text("activity_kind"),
    summary: text("summary").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<unknown[]>().notNull().default([]),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalOccurredIdx: index("goal_activities_goal_occurred_idx").on(table.goalId, table.occurredAt),
    closeoutRunUq: uniqueIndex("goal_activities_closeout_run_uq")
      .on(table.goalId, table.runRef, table.activityKind)
      .where(sql`${table.activityKind} = 'closeout' and ${table.runRef} is not null`),
    idempotencyUq: uniqueIndex("goal_activities_idempotency_uq")
      .on(table.goalId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  }),
);
