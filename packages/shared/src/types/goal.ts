import type {
  GoalActivityKind,
  GoalCloseReason,
  GoalContinuationKind,
  GoalEvaluatorKind,
  GoalLevel,
  GoalLifecycle,
  GoalObjectiveMode,
  GoalStatus,
} from "../constants.js";

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
