import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { organizationSkills } from "./organization_skills.js";
import { organizations } from "./organizations.js";

export const runFeedbackSessions = pgTable(
  "run_feedback_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetSkillId: uuid("target_skill_id").references(() => organizationSkills.id, { onDelete: "set null" }),
    status: text("status").notNull().default("draft"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTargetAgentIdx: index("run_feedback_sessions_org_target_agent_idx").on(table.orgId, table.targetAgentId),
    orgStatusIdx: index("run_feedback_sessions_org_status_idx").on(table.orgId, table.status),
  }),
);

export const runFeedbackItems = pgTable(
  "run_feedback_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => runFeedbackSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    eventId: text("event_id"),
    eventSeq: integer("event_seq"),
    logRef: text("log_ref"),
    logByteStart: bigint("log_byte_start", { mode: "number" }),
    logByteEnd: bigint("log_byte_end", { mode: "number" }),
    transcriptEntryKey: text("transcript_entry_key"),
    selectedTextSnapshot: text("selected_text_snapshot"),
    contentHash: text("content_hash"),
    body: text("body").notNull(),
    feedbackType: text("feedback_type").notNull().default("behavior"),
    severity: text("severity").notNull().default("medium"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgRunIdx: index("run_feedback_items_org_run_idx").on(table.orgId, table.runId),
    sessionIdx: index("run_feedback_items_session_idx").on(table.sessionId),
    agentIdx: index("run_feedback_items_agent_idx").on(table.agentId),
  }),
);

export const feedbackBatches = pgTable(
  "feedback_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => runFeedbackSessions.id, { onDelete: "cascade" }),
    submittedByUserId: text("submitted_by_user_id"),
    submittedByAgentId: uuid("submitted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetSkillId: uuid("target_skill_id").references(() => organizationSkills.id, { onDelete: "set null" }),
    summary: text("summary"),
    status: text("status").notNull().default("submitted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgTargetAgentIdx: index("feedback_batches_org_target_agent_idx").on(table.orgId, table.targetAgentId),
    sessionIdx: index("feedback_batches_session_idx").on(table.sessionId),
    orgStatusIdx: index("feedback_batches_org_status_idx").on(table.orgId, table.status),
  }),
);

export const skillReflections = pgTable(
  "skill_reflections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    timeRangeStart: timestamp("time_range_start", { withTimezone: true }),
    timeRangeEnd: timestamp("time_range_end", { withTimezone: true }),
    runCount: integer("run_count").notNull().default(0),
    summary: text("summary"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgAgentIdx: index("skill_reflections_org_agent_idx").on(table.orgId, table.agentId),
    orgStatusIdx: index("skill_reflections_org_status_idx").on(table.orgId, table.status),
  }),
);

export const learningCandidates = pgTable(
  "learning_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    feedbackBatchId: uuid("feedback_batch_id").references(() => feedbackBatches.id, { onDelete: "cascade" }),
    reflectionId: uuid("reflection_id").references(() => skillReflections.id, { onDelete: "set null" }),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    targetSkillId: uuid("target_skill_id").references(() => organizationSkills.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    instruction: text("instruction").notNull(),
    appliesWhenJson: jsonb("applies_when_json").$type<Record<string, unknown>>().notNull().default({}),
    mustNot: text("must_not"),
    targetSkillReason: text("target_skill_reason"),
    classification: text("classification").notNull().default("core_behavior"),
    confidence: text("confidence").notNull().default("medium"),
    riskLevel: text("risk_level").notNull().default("low"),
    validationChecksJson: jsonb("validation_checks_json").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgBatchIdx: index("learning_candidates_org_batch_idx").on(table.orgId, table.feedbackBatchId),
    orgAgentStatusIdx: index("learning_candidates_org_agent_status_idx").on(
      table.orgId,
      table.targetAgentId,
      table.status,
    ),
  }),
);

export const skillUpdateProposals = pgTable(
  "skill_update_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    targetSkillId: uuid("target_skill_id").references(() => organizationSkills.id, { onDelete: "set null" }),
    targetSkillKey: text("target_skill_key"),
    targetAgentId: uuid("target_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    baseRevisionId: uuid("base_revision_id"),
    baseContentHash: text("base_content_hash"),
    title: text("title").notNull(),
    summary: text("summary"),
    patchJson: jsonb("patch_json").$type<Record<string, unknown>>().notNull().default({}),
    markdownDiff: text("markdown_diff"),
    structuredSpecDiffJson: jsonb("structured_spec_diff_json").$type<Record<string, unknown>>(),
    rationale: text("rationale"),
    expectedBehavior: text("expected_behavior"),
    validationChecksJson: jsonb("validation_checks_json").$type<string[]>().notNull().default([]),
    riskLevel: text("risk_level").notNull().default("low"),
    status: text("status").notNull().default("pending"),
    approvedByUserId: text("approved_by_user_id"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    approvalId: uuid("approval_id"),
    rollbackPlan: text("rollback_plan"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgAgentStatusIdx: index("skill_update_proposals_org_agent_status_idx").on(
      table.orgId,
      table.targetAgentId,
      table.status,
    ),
    orgSkillIdx: index("skill_update_proposals_org_skill_idx").on(table.orgId, table.targetSkillId),
  }),
);

export const organizationSkillRevisions = pgTable(
  "organization_skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").notNull().references(() => organizationSkills.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    markdown: text("markdown").notNull(),
    structuredSpecJson: jsonb("structured_spec_json").$type<Record<string, unknown>>(),
    contentHash: text("content_hash").notNull(),
    sourceProposalId: uuid("source_proposal_id"),
    createdFromFeedbackBatchId: uuid("created_from_feedback_batch_id").references(() => feedbackBatches.id, {
      onDelete: "set null",
    }),
    createdFromReflectionId: uuid("created_from_reflection_id").references(() => skillReflections.id, {
      onDelete: "set null",
    }),
    status: text("status").notNull().default("approved"),
    approvedByUserId: text("approved_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    skillRevisionUniqueIdx: uniqueIndex("organization_skill_revisions_skill_revision_idx").on(
      table.skillId,
      table.revision,
    ),
    orgSkillIdx: index("organization_skill_revisions_org_skill_idx").on(table.orgId, table.skillId),
    orgCreatedIdx: index("organization_skill_revisions_org_created_idx").on(table.orgId, table.createdAt),
  }),
);

export const skillEvidenceLinks = pgTable(
  "skill_evidence_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    skillUpdateProposalId: uuid("skill_update_proposal_id").references(() => skillUpdateProposals.id, {
      onDelete: "cascade",
    }),
    skillRevisionId: uuid("skill_revision_id").references(() => organizationSkillRevisions.id, {
      onDelete: "cascade",
    }),
    feedbackItemId: uuid("feedback_item_id").references(() => runFeedbackItems.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    eventId: text("event_id"),
    eventSeq: integer("event_seq"),
    evidenceSummary: text("evidence_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProposalIdx: index("skill_evidence_links_org_proposal_idx").on(table.orgId, table.skillUpdateProposalId),
    orgRevisionIdx: index("skill_evidence_links_org_revision_idx").on(table.orgId, table.skillRevisionId),
    orgRunIdx: index("skill_evidence_links_org_run_idx").on(table.orgId, table.runId),
  }),
);

export const runLoadedSkillRevisions = pgTable(
  "run_loaded_skill_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillKey: text("skill_key").notNull(),
    skillRevisionId: uuid("skill_revision_id").references(() => organizationSkillRevisions.id, {
      onDelete: "set null",
    }),
    contentHash: text("content_hash"),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runSkillUniqueIdx: uniqueIndex("run_loaded_skill_revisions_run_skill_idx").on(table.runId, table.skillKey),
    orgRunIdx: index("run_loaded_skill_revisions_org_run_idx").on(table.orgId, table.runId),
    orgAgentIdx: index("run_loaded_skill_revisions_org_agent_idx").on(table.orgId, table.agentId),
  }),
);

export const skillEvaluationReports = pgTable(
  "skill_evaluation_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id").references(() => organizationSkills.id, { onDelete: "set null" }),
    skillRevisionId: uuid("skill_revision_id").references(() => organizationSkillRevisions.id, {
      onDelete: "set null",
    }),
    score: real("score"),
    applicableChecksJson: jsonb("applicable_checks_json").$type<string[]>().notNull().default([]),
    passedItemsJson: jsonb("passed_items_json").$type<string[]>().notNull().default([]),
    missedItemsJson: jsonb("missed_items_json").$type<string[]>().notNull().default([]),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgRunIdx: index("skill_evaluation_reports_org_run_idx").on(table.orgId, table.runId),
    orgAgentIdx: index("skill_evaluation_reports_org_agent_idx").on(table.orgId, table.agentId),
  }),
);
