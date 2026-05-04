import type { Agent } from "./agent.js";

export type LearningCandidateClassification =
  | "core_behavior"
  | "contextual_preference"
  | "one_off_correction"
  | "conflicting_signal"
  | "open_question";

export type LearningCandidateStatus = "pending" | "approved" | "rejected" | "one_off" | "applied";
export type LearningConfidence = "low" | "medium" | "high";
export type LearningRiskLevel = "low" | "medium" | "high";
export type RunFeedbackSessionStatus = "draft" | "submitted" | "closed";
export type FeedbackBatchStatus = "submitted" | "reviewing" | "applied" | "closed";
export type SkillUpdateProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface RunFeedbackSession {
  id: string;
  orgId: string;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  targetAgentId: string;
  targetSkillId: string | null;
  status: RunFeedbackSessionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunFeedbackItem {
  id: string;
  orgId: string;
  sessionId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  sourceKind: string;
  sourceId: string | null;
  eventId: string | null;
  eventSeq: number | null;
  logRef: string | null;
  logByteStart: number | null;
  logByteEnd: number | null;
  transcriptEntryKey: string | null;
  selectedTextSnapshot: string | null;
  contentHash: string | null;
  body: string;
  feedbackType: string;
  severity: string;
  createdAt: Date;
}

export interface FeedbackBatch {
  id: string;
  orgId: string;
  sessionId: string;
  submittedByUserId: string | null;
  submittedByAgentId: string | null;
  targetAgentId: string;
  targetSkillId: string | null;
  summary: string | null;
  status: FeedbackBatchStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface LearningCandidate {
  id: string;
  orgId: string;
  feedbackBatchId: string | null;
  reflectionId: string | null;
  targetAgentId: string;
  targetSkillId: string | null;
  title: string;
  instruction: string;
  appliesWhenJson: Record<string, unknown>;
  mustNot: string | null;
  targetSkillReason: string | null;
  classification: LearningCandidateClassification;
  confidence: LearningConfidence;
  riskLevel: LearningRiskLevel;
  validationChecksJson: string[];
  status: LearningCandidateStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillUpdateProposal {
  id: string;
  orgId: string;
  targetSkillId: string | null;
  targetSkillKey: string | null;
  targetAgentId: string;
  baseRevisionId: string | null;
  baseContentHash: string | null;
  title: string;
  summary: string | null;
  patchJson: Record<string, unknown>;
  markdownDiff: string | null;
  structuredSpecDiffJson: Record<string, unknown> | null;
  rationale: string | null;
  expectedBehavior: string | null;
  validationChecksJson: string[];
  riskLevel: LearningRiskLevel;
  status: SkillUpdateProposalStatus;
  approvedByUserId: string | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  approvalId: string | null;
  rollbackPlan: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentLearningSkillPreview {
  id: string;
  key: string;
  slug: string;
  name: string;
  description: string | null;
  selectionKey: string;
  sourcePath: string | null;
  workspaceEditPath: string | null;
  scope: "agent";
}

export interface OrganizationSkillRevision {
  id: string;
  orgId: string;
  skillId: string;
  revision: number;
  markdown: string;
  structuredSpecJson: Record<string, unknown> | null;
  contentHash: string;
  sourceProposalId: string | null;
  createdFromFeedbackBatchId: string | null;
  createdFromReflectionId: string | null;
  status: string;
  approvedByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
}

export interface AgentSkillRevision {
  id: string;
  orgId: string;
  agentId: string;
  skillKey: string;
  skillSlug: string;
  revision: number;
  markdown: string;
  structuredSpecJson: Record<string, unknown> | null;
  contentHash: string;
  sourceProposalId: string | null;
  createdFromFeedbackBatchId: string | null;
  createdFromReflectionId: string | null;
  status: string;
  approvedByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
}

export interface SkillEvidenceLink {
  id: string;
  orgId: string;
  skillUpdateProposalId: string | null;
  skillRevisionId: string | null;
  agentSkillRevisionId: string | null;
  feedbackItemId: string | null;
  runId: string | null;
  issueId: string | null;
  eventId: string | null;
  eventSeq: number | null;
  evidenceSummary: string | null;
  createdAt: Date;
}

export interface RunLoadedSkillRevision {
  id: string;
  orgId: string;
  runId: string;
  agentId: string;
  skillKey: string;
  skillRevisionId: string | null;
  agentSkillRevisionId: string | null;
  contentHash: string | null;
  loadedAt: Date;
}

export interface SkillEvaluationReport {
  id: string;
  orgId: string;
  runId: string;
  agentId: string;
  skillId: string | null;
  skillRevisionId: string | null;
  agentSkillRevisionId: string | null;
  score: number | null;
  applicableChecksJson: string[];
  passedItemsJson: string[];
  missedItemsJson: string[];
  notes: string | null;
  createdAt: Date;
}

export interface CreateRunFeedbackSessionRequest {
  targetAgentId: string;
  targetSkillId?: string | null;
}

export interface CreateRunFeedbackItemRequest {
  runId: string;
  issueId?: string | null;
  sourceKind: string;
  sourceId?: string | null;
  eventId?: string | null;
  eventSeq?: number | null;
  logRef?: string | null;
  logByteStart?: number | null;
  logByteEnd?: number | null;
  transcriptEntryKey?: string | null;
  selectedTextSnapshot?: string | null;
  contentHash?: string | null;
  body: string;
  feedbackType?: string;
  severity?: string;
}

export interface UpdateLearningCandidateRequest {
  title?: string;
  instruction?: string;
  appliesWhenJson?: Record<string, unknown>;
  mustNot?: string | null;
  targetSkillId?: string | null;
  classification?: LearningCandidateClassification;
  riskLevel?: LearningRiskLevel;
  validationChecksJson?: string[];
  status?: LearningCandidateStatus;
}

export interface SubmitRunFeedbackSessionResponse {
  batch: FeedbackBatch;
  candidates: LearningCandidate[];
}

export interface FeedbackBatchReview {
  batch: FeedbackBatch;
  session: RunFeedbackSession;
  agent: Pick<Agent, "id" | "name" | "urlKey" | "title" | "role" | "agentRuntimeType">;
  targetSkill: AgentLearningSkillPreview | null;
  feedbackItems: RunFeedbackItem[];
  candidates: LearningCandidate[];
  proposals: SkillUpdateProposal[];
  revisions: AgentSkillRevision[];
  evidenceLinks: SkillEvidenceLink[];
}

export interface ApplyApprovedLearningResponse {
  batch: FeedbackBatch;
  appliedCandidates: LearningCandidate[];
  proposals: SkillUpdateProposal[];
  revisions: AgentSkillRevision[];
  skill: AgentLearningSkillPreview | null;
}

export interface AgentLearningSummary {
  agentId: string;
  managedSkill: AgentLearningSkillPreview | null;
  activeLearnings: Array<{
    id: string;
    title: string;
    instruction: string;
    appliesWhenJson: Record<string, unknown>;
    mustNot: string | null;
    revisionId: string | null;
    revision: number | null;
    createdAt: Date;
  }>;
  suggestedUpdates: LearningCandidate[];
  recentFeedbackItems: RunFeedbackItem[];
  recentRevisions: AgentSkillRevision[];
  recentMisses: SkillEvaluationReport[];
  stats: {
    activeLearningCount: number;
    suggestedCount: number;
    recentFeedbackCount: number;
    recentRevisionCount: number;
    recentMissCount: number;
  };
}

export interface RunLoadedSkillsSummary {
  runId: string;
  loadedSkills: Array<{
    skillKey: string;
    skillName: string | null;
    skillRevisionId: string | null;
    agentSkillRevisionId: string | null;
    revision: number | null;
    contentHash: string | null;
    recentLearnings: Array<{
      title: string;
      instruction: string;
    }>;
  }>;
  evaluations: SkillEvaluationReport[];
}
