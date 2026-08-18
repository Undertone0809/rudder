import type {
  GoalChangeProposal,
  GoalChangeProposalStatus,
  GoalCheckpointContinuation,
  GoalFeedbackAttachment,
  GoalFeedbackKind,
  GoalResultProposal,
  GoalResultProposalStatus,
  GoalStartPacket,
  GoalStartRequestStatus,
  IssueAssigneeAgentRuntimeOverrides,
} from "@rudderhq/shared";
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
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { organizations } from "./organizations.js";

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    title: text("title").notNull(),
    description: text("description"),
    alignmentQuestion: text("alignment_question"),
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
    ownerAgentRuntimeOverrides: jsonb("owner_agent_runtime_overrides").$type<IssueAssigneeAgentRuntimeOverrides | null>(),
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

/**
 * Append-only facts emitted by a Goal owner at the end of a bounded run.
 * Current Goal/Plan fields remain on their existing tables; this table keeps
 * the exact handoff facts needed to replay a continuation or audit a replan.
 */
export const goalCheckpoints = pgTable(
  "goal_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "restrict" }),
    ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    submittedByAgentId: uuid("submitted_by_agent_id").notNull().references(() => agents.id, { onDelete: "restrict" }),
    inputHash: text("input_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    summary: text("summary").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    planPayload: jsonb("plan_payload").$type<Record<string, unknown> | null>(),
    planRevisionBefore: integer("plan_revision_before").notNull(),
    planRevisionAfter: integer("plan_revision_after").notNull(),
    continuationKind: text("continuation_kind").$type<GoalCheckpointContinuation["kind"]>().notNull(),
    continuationSummary: text("continuation_summary").notNull(),
    wakeCondition: text("wake_condition"),
    continuationWakeupRequestId: uuid("continuation_wakeup_request_id").references(
      () => agentWakeupRequests.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalCreatedIdx: index("goal_checkpoints_goal_created_idx").on(table.goalId, table.createdAt),
    goalRunIdx: index("goal_checkpoints_goal_run_idx").on(table.goalId, table.runId),
    goalIdempotencyUq: uniqueIndex("goal_checkpoints_goal_idempotency_uq").on(
      table.goalId,
      table.idempotencyKey,
    ),
    continuationWakeUq: uniqueIndex("goal_checkpoints_continuation_wake_uq")
      .on(table.continuationWakeupRequestId)
      .where(sql`${table.continuationWakeupRequestId} is not null`),
  }),
);

export const goalStartRequests = pgTable(
  "goal_start_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestKey: text("request_key").notNull(),
    packetHash: text("packet_hash").notNull(),
    packet: jsonb("packet").$type<GoalStartPacket>().notNull(),
    draftGoalId: uuid("draft_goal_id").references(() => goals.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    status: text("status").$type<GoalStartRequestStatus>().notNull().default("pending"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgRequestKeyUq: uniqueIndex("goal_start_requests_org_request_key_uq").on(
      table.orgId,
      table.requestKey,
    ),
    orgStatusUpdatedIdx: index("goal_start_requests_org_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
  }),
);

export const goalFeedbackEntries = pgTable(
  "goal_feedback_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<"user">().notNull(),
    actorId: text("actor_id").notNull(),
    body: text("body").notNull(),
    attachments: jsonb("attachments").$type<GoalFeedbackAttachment[]>().notNull().default([]),
    contentHash: text("content_hash").notNull(),
    feedbackKind: text("feedback_kind").$type<GoalFeedbackKind>().notNull().default("ordinary"),
    idempotencyKey: text("idempotency_key").notNull(),
    routedWakeupRequestId: uuid("routed_wakeup_request_id").references(
      () => agentWakeupRequests.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalCreatedIdx: index("goal_feedback_entries_goal_created_idx").on(table.goalId, table.createdAt),
    goalIdempotencyUq: uniqueIndex("goal_feedback_entries_goal_idempotency_uq").on(
      table.goalId,
      table.idempotencyKey,
    ),
  }),
);

export const goalChangeProposals = pgTable(
  "goal_change_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    expectedContractRevision: integer("expected_contract_revision").notNull(),
    beforeContract: jsonb("before_contract").$type<GoalChangeProposal["beforeContract"]>().notNull(),
    afterContract: jsonb("after_contract").$type<GoalChangeProposal["afterContract"]>().notNull(),
    rationale: text("rationale").notNull(),
    evidenceRefs: jsonb("evidence_refs").$type<string[]>().notNull().default([]),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    status: text("status").$type<GoalChangeProposalStatus>().notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id").notNull().references(() => agents.id),
    appliedRevision: integer("applied_revision"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalStatusCreatedIdx: index("goal_change_proposals_goal_status_created_idx").on(
      table.goalId,
      table.status,
      table.createdAt,
    ),
    goalIdempotencyUq: uniqueIndex("goal_change_proposals_goal_idempotency_uq").on(
      table.goalId,
      table.idempotencyKey,
    ),
    approvalUq: uniqueIndex("goal_change_proposals_approval_uq").on(table.approvalId),
  }),
);

export const goalResultProposals = pgTable(
  "goal_result_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
    contractRevision: integer("contract_revision").notNull(),
    candidate: jsonb("candidate").$type<GoalResultProposal["candidate"]>().notNull(),
    candidateHash: text("candidate_hash").notNull(),
    preflight: jsonb("preflight").$type<GoalResultProposal["preflight"]>().notNull(),
    riskSummary: text("risk_summary").notNull(),
    status: text("status").$type<GoalResultProposalStatus>().notNull().default("ready"),
    idempotencyKey: text("idempotency_key").notNull(),
    proposedByAgentId: uuid("proposed_by_agent_id").notNull().references(() => agents.id),
    acceptedByActorType: text("accepted_by_actor_type").$type<"user">(),
    acceptedByActorId: text("accepted_by_actor_id"),
    acceptanceIdempotencyKey: text("acceptance_idempotency_key"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedByActorType: text("rejected_by_actor_type").$type<"user">(),
    rejectedByActorId: text("rejected_by_actor_id"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionFeedback: text("rejection_feedback"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    goalStatusCreatedIdx: index("goal_result_proposals_goal_status_created_idx").on(
      table.goalId,
      table.status,
      table.createdAt,
    ),
    goalIdempotencyUq: uniqueIndex("goal_result_proposals_goal_idempotency_uq").on(
      table.goalId,
      table.idempotencyKey,
    ),
    goalReadyUq: uniqueIndex("goal_result_proposals_goal_ready_uq")
      .on(table.goalId)
      .where(sql`${table.status} = 'ready'`),
  }),
);
