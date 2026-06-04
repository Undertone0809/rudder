type MaybeId = string | null | undefined;

export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId !== undefined) {
    return input.goalId ?? null;
  }

  if (!input.projectId) {
    return input.defaultGoalId ?? null;
  }
  return null;
}

export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId !== undefined) {
    return input.goalId ?? null;
  }

  if (input.projectId === undefined) {
    return input.currentGoalId ?? null;
  }

  if (input.projectId === input.currentProjectId) {
    return input.currentGoalId ?? null;
  }

  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const goalId = input.currentGoalId;

  if (!projectId && !goalId) {
    return input.defaultGoalId ?? null;
  }
  return goalId ?? null;
}
