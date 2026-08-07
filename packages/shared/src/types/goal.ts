import type {
  GoalActivityKind,
  GoalChangeProposalStatus,
  GoalCloseReason,
  GoalContinuationKind,
  GoalEvaluatorKind,
  GoalFeedbackKind,
  GoalLevel,
  GoalLifecycle,
  GoalObjectiveMode,
  GoalResultProposalStatus,
  GoalStartRequestStatus,
  GoalStatus,
  GoalWorkspaceFacet,
} from "../constants.js";
import type { ActivateGoalInput, EvaluateGoal } from "../validators/goal.js";

export interface GoalCriterion {
  id: string;
  label: string;
  evaluator: GoalEvaluatorKind;
  evidenceRequirements?: string[];
}

export interface GoalContinuation {
  kind: GoalContinuationKind;
  summary: string;
  wakeCondition?: string | null;
}

export interface GoalPlan {
  id: string;
  orgId: string;
  goalId: string;
  revision: number;
  summary: string;
  hypotheses: unknown[];
  selectedPaths: unknown[];
  rejectedPaths: unknown[];
  sequencing: unknown[];
  budgetAllocations: Record<string, unknown>;
  invalidationConditions: unknown[];
  createdByAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalActivity {
  id: string;
  orgId: string;
  goalId: string;
  contractRevision: number;
  submittedByAgentId: string | null;
  agentOwnerRefAtTime: string | null;
  commitmentRef: string | null;
  runRef: string | null;
  activityKind: GoalActivityKind | null;
  summary: string;
  evidenceRefs: unknown[];
  idempotencyKey: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface GoalOwnerAssignment {
  id: string;
  orgId: string;
  goalId: string;
  agentId: string;
  assignmentRevision: number;
  assignedByAuthorityRef: string | null;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
}

export interface Goal {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  alignmentQuestion?: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  /** Optional on legacy API records until the Goal contract migration runs. */
  outcomeStatement?: string | null;
  objectiveMode?: GoalObjectiveMode;
  lifecycle?: GoalLifecycle;
  contractRevision?: number;
  criteria?: GoalCriterion[];
  autonomyEnvelope?: Record<string, unknown>;
  humanAuthorities?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown>;
  actionDeadline?: Date | null;
  evaluationDeadline?: Date | null;
  evaluationResult?: Record<string, unknown> | null;
  closeReason?: GoalCloseReason | null;
  resultPayload?: Record<string, unknown> | null;
  focus?: boolean;
  planRevision?: number;
  continuationKind?: GoalContinuationKind | null;
  continuationSummary?: string | null;
  wakeCondition?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalStartPacket {
  version: 1;
  title: string;
  description: string | null;
  ownerAgentId: string;
  activation: ActivateGoalInput;
}

export interface GoalStartPreview {
  valid: boolean;
  packetHash: string | null;
  packet: GoalStartPacket | null;
  review: {
    outcome: string;
    success: string;
    boundary: string;
    firstAction: string;
    owner?: string | null;
    ownerAgentId?: string;
    targetTime?: Date | string | null;
  } | null;
  alignmentQuestion: string | null;
  warning: string | null;
}

export interface GoalStartRequest {
  id: string;
  orgId: string;
  requestKey: string;
  packetHash: string;
  packet: GoalStartPacket;
  draftGoalId: string | null;
  goalId: string | null;
  status: GoalStartRequestStatus;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalFeedbackAttachment {
  name: string;
  uri: string;
  mimeType?: string;
  size?: number;
}

export interface GoalFeedbackEntry {
  id: string;
  orgId: string;
  goalId: string;
  actorType: "user";
  actorId: string;
  body: string;
  attachments: GoalFeedbackAttachment[];
  contentHash: string;
  feedbackKind: GoalFeedbackKind;
  idempotencyKey: string;
  routedWakeupRequestId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalHistoryAttachment {
  name: string;
  mimeType: string | null;
  size: number | null;
  contentPath: string | null;
}

export interface GoalHistoryItem {
  id: string;
  kind: "activity" | "feedback" | "change_proposal" | "result_proposal";
  summary: string;
  createdAt: Date | string;
  evidenceRefs: string[];
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  actorName: string;
  attachments: GoalHistoryAttachment[];
  feedbackKind?: GoalFeedbackKind;
  approvalId?: string;
  status?: string;
}

export interface GoalHistoryPage {
  items: GoalHistoryItem[];
  nextCursor: string | null;
}

export interface GoalContractSnapshot {
  contractRevision: number;
  outcomeStatement: string;
  objectiveMode: GoalObjectiveMode;
  criteria: GoalCriterion[];
  autonomyEnvelope: Record<string, unknown>;
  humanAuthorities: Record<string, unknown>;
  evaluationPolicy: Record<string, unknown>;
  actionDeadline: Date | string | null;
  evaluationDeadline: Date | string | null;
}

export interface GoalContractPatch {
  outcomeStatement?: string;
  objectiveMode?: GoalObjectiveMode;
  criteria?: GoalCriterion[];
  autonomyEnvelope?: Record<string, unknown>;
  humanAuthorities?: Record<string, unknown>;
  evaluationPolicy?: Record<string, unknown>;
  actionDeadline?: Date | string | null;
  evaluationDeadline?: Date | string | null;
}

export interface GoalChangeProposal {
  id: string;
  orgId: string;
  goalId: string;
  expectedContractRevision: number;
  beforeContract: GoalContractSnapshot;
  afterContract: GoalContractPatch;
  rationale: string;
  evidenceRefs: string[];
  approvalId: string;
  status: GoalChangeProposalStatus;
  idempotencyKey: string;
  proposedByAgentId: string;
  appliedRevision: number | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type GoalEvaluationCandidate = Omit<EvaluateGoal, "resultProposalId">;

export interface GoalResultReducerPreflight {
  mode: GoalObjectiveMode;
  outcome: string;
  criteria: Array<{
    id: string;
    evaluator: GoalEvaluatorKind | null;
    status: "met" | "unmet" | "breached" | "unknown";
    evidenceSatisfied: boolean;
    missingEvidence: string[];
  }>;
  evidenceRefs: string[];
  resultValue?: string | number | boolean;
  decision: string | null;
  evaluatedAt: string;
}

export interface GoalResultProposal {
  id: string;
  orgId: string;
  goalId: string;
  contractRevision: number;
  candidate: GoalEvaluationCandidate;
  candidateHash: string;
  preflight: GoalResultReducerPreflight;
  riskSummary: string;
  status: GoalResultProposalStatus;
  idempotencyKey: string;
  proposedByAgentId: string;
  acceptedByActorType: "user" | null;
  acceptedByActorId: string | null;
  acceptanceIdempotencyKey: string | null;
  acceptedAt: Date | null;
  rejectedByActorType: "user" | null;
  rejectedByActorId: string | null;
  rejectedAt: Date | null;
  rejectionFeedback: string | null;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GoalWorkspaceCard {
  id: string;
  title: string;
  facet: GoalWorkspaceFacet;
  lifecycle?: GoalLifecycle;
  focus?: boolean;
  ownerAgentId?: string | null;
  ownerName?: string | null;
  progressSummary: string;
  nextStepSummary: string;
  attentionReason?: string | null;
  targetTime?: Date | string | null;
}

export interface GoalWorkspaceSummary {
  goal: Goal;
  facet: GoalWorkspaceFacet;
  currentGoal?: {
    summary: string;
    revision?: number;
    updatedFromEvidence?: boolean;
  };
  currentProgress: {
    summary: string;
    sourceActivityId: string | null;
    evidenceRefs: string[];
    uncertainty?: string | null;
  };
  agentAction?: {
    summary: string;
    sourceIds?: string[];
    status?: string;
  } | null;
  nextStep?: {
    summary: string;
    wakeCondition?: string | null;
  } | null;
  attention?: {
    kind: string;
    reason: string;
    sourceId: string | null;
    impact?: string | null;
    evidenceRefs?: string[];
  } | null;
  timeline: GoalHistoryItem[];
  timelineNextCursor: string | null;
  changeProposals?: GoalChangeProposal[];
  resultProposals: GoalResultProposal[];
}

export interface GoalDependencyPreview {
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface GoalDependencies {
  goalId: string;
  orgId: string;
  canDelete: boolean;
  blockers: string[];
  isLastRootOrganizationGoal: boolean;
  counts: {
    childGoals: number;
    linkedProjects: number;
    linkedIssues: number;
    automations: number;
    calendarEvents: number;
    costEvents: number;
    financeEvents: number;
  };
  previews: {
    childGoals: GoalDependencyPreview[];
    linkedProjects: GoalDependencyPreview[];
    linkedIssues: GoalDependencyPreview[];
    automations: GoalDependencyPreview[];
    calendarEvents: GoalDependencyPreview[];
  };
}
