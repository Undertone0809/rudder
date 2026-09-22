import { goals } from "@rudderhq/db";
import type {
  CreateGoalChangeProposal,
  GoalContractPatch,
  GoalContractSnapshot,
  GoalDependencyPreview,
} from "@rudderhq/shared";
import { conflict, forbidden } from "../errors.js";

type GoalRow = typeof goals.$inferSelect;

export const DEPENDENCY_PREVIEW_LIMIT = 5;

function toIsoString(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function goalContractSnapshot(goal: GoalRow): GoalContractSnapshot {
  return {
    contractRevision: goal.contractRevision,
    outcomeStatement: goal.outcomeStatement ?? "",
    objectiveMode: goal.objectiveMode as GoalContractSnapshot["objectiveMode"],
    criteria: goal.criteria as GoalContractSnapshot["criteria"],
    autonomyEnvelope: goal.autonomyEnvelope,
    humanAuthorities: goal.humanAuthorities,
    evaluationPolicy: goal.evaluationPolicy,
    actionDeadline: toIsoString(goal.actionDeadline),
    evaluationDeadline: toIsoString(goal.evaluationDeadline),
  };
}

export function normalizeContractPatch(patch: CreateGoalChangeProposal["afterContract"]): GoalContractPatch {
  return {
    ...patch,
    ...(patch.actionDeadline !== undefined ? { actionDeadline: toIsoString(patch.actionDeadline) } : {}),
    ...(patch.evaluationDeadline !== undefined ? { evaluationDeadline: toIsoString(patch.evaluationDeadline) } : {}),
  } as GoalContractPatch;
}

export function countRows(rows: Array<{ count: unknown }>) {
  return Number(rows[0]?.count ?? 0);
}

export function previewRows<T>(rows: T[], map: (row: T) => GoalDependencyPreview) {
  return rows.slice(0, DEPENDENCY_PREVIEW_LIMIT).map(map);
}

export function assertCanonicalActiveGoal(
  goal: Pick<GoalRow, "lifecycle" | "ownerAgentId" | "outcomeStatement" | "criteria" | "planRevision" | "continuationKind" | "continuationSummary">,
) {
  if (goal.lifecycle !== "active") throw conflict("Only active Goals can receive this command");
  if (!goal.ownerAgentId || !goal.outcomeStatement?.trim() || !Array.isArray(goal.criteria) || goal.criteria.length === 0
    || goal.planRevision < 1 || !goal.continuationKind || !goal.continuationSummary?.trim()) {
    throw conflict("Goal requires Contract activation before this command");
  }
}

export function assertGoalOwner(goal: Pick<GoalRow, "ownerAgentId">, actorAgentId: string | null) {
  if (actorAgentId && actorAgentId !== goal.ownerAgentId) {
    throw forbidden("Only the Goal Owner can perform this Agent command");
  }
}
