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
import type { IssueAssigneeAgentRuntimeOverrides } from "./issue.js";

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

/** The Plan payload accepted when a bounded Goal run advances its Plan. */
export interface GoalPlanPayload {
  summary: string;
  hypotheses: unknown[];
  selectedPaths: unknown[];
  rejectedPaths: unknown[];
  sequencing: unknown[];
  budgetAllocations: Record<string, unknown>;
  invalidationConditions: unknown[];
}

export interface GoalCheckpointContinuation extends GoalContinuation {
  kind: GoalContinuationKind;
}

/** Durable append-only handoff facts for one bounded Goal run. */
export interface GoalCheckpoint {
  id: string;
  orgId: string;
  goalId: string;
  runId: string;
  ownerAgentId: string;
  submittedByAgentId: string;
  inputHash: string;
  idempotencyKey: string;
  summary: string;
  evidenceRefs: string[];
  planPayload: Record<string, unknown> | null;
  planRevisionBefore: number;
  planRevisionAfter: number;
  continuation: GoalCheckpointContinuation;
  continuationWakeupRequestId: string | null;
  createdAt: Date;
}

/** Wire payload for rudder_goal_checkpoint. */
export interface GoalCheckpointInput {
  goal: string;
  summary: string;
  evidenceRefs: string[];
  expectedPlanRevision: number;
  plan?: GoalPlanPayload;
  continuation: GoalCheckpointContinuation;
  idempotencyKey: string;
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
  ownerAgentRuntimeOverrides?: IssueAssigneeAgentRuntimeOverrides | null;
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

/** Public Goal fields returned by the user-facing Goal workspace APIs. */
export interface PublicGoalCriterion {
  id: string;
  label: string;
}

export interface PublicGoal {
  id: string;
  orgId: string;
  title: string;
  description: string | null;
  lifecycle: GoalLifecycle;
  status: GoalStatus;
  outcomeStatement: string | null;
  criteria: PublicGoalCriterion[];
  ownerAgentId: string | null;
  ownerAgentRuntimeOverrides?: IssueAssigneeAgentRuntimeOverrides | null;
  focus: boolean;
  evaluationResult: { outcome: string } | null;
  evaluationDeadline: Date | string | null;
  actionDeadline: Date | string | null;
  continuationSummary: string | null;
  wakeCondition: string | null;
  alignmentQuestion: string | null;
  closeReason: GoalCloseReason | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PublicGoalActivity {
  id: string;
  orgId: string;
  goalId: string;
  activityKind: GoalActivityKind | null;
  summary: string;
  evidence: GoalEvidenceItem[];
  occurredAt: Date | string;
  createdAt: Date | string;
}

export interface PublicGoalPlan {
  id: string;
  orgId: string;
  goalId: string;
  revision: number;
  summary: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PublicGoalOwnerAssignment {
  id: string;
  orgId: string;
  goalId: string;
  agentId: string;
  assignmentRevision: number;
  startsAt: Date | string;
  endsAt: Date | string | null;
  createdAt: Date | string;
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
  blockers: Array<{
    code: "outcome_required" | "owner_required";
    field: "goal" | "ownerAgentId";
    message: string;
  }>;
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

/** User-facing evidence descriptor. Raw evidence references stay server-side. */
export interface GoalEvidenceItem {
  label: string;
  href: string | null;
  external: boolean;
}

export interface GoalHistoryItem {
  id: string;
  kind: "activity" | "feedback" | "change_proposal" | "result_proposal";
  summary: string;
  createdAt: Date | string;
  actorType: "user" | "agent" | "system";
  actorId: string | null;
  actorName: string;
  attachments: GoalHistoryAttachment[];
  evidence?: GoalEvidenceItem[];
  feedbackKind?: GoalFeedbackKind;
  approvalId?: string;
  status?: string;
}

export interface PublicGoalChangeProposal {
  id: string;
  approvalId: string;
  status: GoalChangeProposalStatus;
  rationale: string;
  evidence: GoalEvidenceItem[];
  beforeSummary: Record<string, unknown>;
  afterSummary: Record<string, unknown>;
}

export interface PublicGoalResultProposal {
  id: string;
  status: GoalResultProposalStatus;
  outcome: string;
  outcomeLabel: string;
  criteria: Array<{
    id: string;
    status: string;
    missingEvidenceCount: number;
  }>;
  evidence: GoalEvidenceItem[];
  riskSummary: string | null;
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
  evidence?: GoalEvidenceItem[];
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
  evidence?: GoalEvidenceItem[];
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
  goal: PublicGoal;
  facet: GoalWorkspaceFacet;
  currentGoal?: {
    summary: string;
    revision?: number;
    updatedFromEvidence?: boolean;
  };
  currentProgress: {
    summary: string;
    sourceActivityId: string | null;
    evidence?: GoalEvidenceItem[];
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
    evidence?: GoalEvidenceItem[];
  } | null;
  timeline: GoalHistoryItem[];
  timelineNextCursor: string | null;
  changeProposals?: PublicGoalChangeProposal[];
  resultProposals: PublicGoalResultProposal[];
}

export type GoalAgentListLifecycle = GoalLifecycle | "all";

export interface GoalAgentListResponse {
  goals: GoalWorkspaceCard[];
  count: number;
  filters: {
    lifecycle: GoalAgentListLifecycle;
    focus: boolean | null;
    facet: GoalWorkspaceFacet | null;
    limit: number;
  };
}

export interface GoalAgentContext {
  goal: Pick<PublicGoal,
    | "id"
    | "orgId"
    | "title"
    | "description"
    | "lifecycle"
    | "status"
    | "ownerAgentId"
    | "focus"
    | "closeReason"
    | "createdAt"
    | "updatedAt"
  >;
  contract: {
    revision: number;
    outcomeStatement: string | null;
    objectiveMode: GoalObjectiveMode;
    criteria: GoalCriterion[];
    autonomyEnvelope: Record<string, unknown>;
    humanAuthorities: Record<string, unknown>;
    evaluationPolicy: Record<string, unknown>;
    actionDeadline: Date | string | null;
    evaluationDeadline: Date | string | null;
  };
  plan: Pick<GoalPlan, "revision" | "summary" | "hypotheses" | "selectedPaths" | "rejectedPaths" | "sequencing" | "budgetAllocations" | "invalidationConditions"> | null;
  continuation: GoalContinuation | null;
  latestCheckpoint: GoalCheckpoint | null;
  recentCheckpoints: GoalCheckpoint[];
  pendingContinuationWake: {
    id: string;
    status: string;
    planRevision: number | null;
    checkpointId: string | null;
  } | null;
  state: Pick<GoalWorkspaceSummary,
    | "facet"
    | "currentProgress"
    | "agentAction"
    | "nextStep"
    | "attention"
  >;
  pending: {
    changeProposals: PublicGoalChangeProposal[];
    resultProposals: PublicGoalResultProposal[];
  };
  recentHistory: GoalHistoryItem[];
  allowedActions: {
    reportProgress: boolean;
    proposeChange: boolean;
    proposeResult: boolean;
  };
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
