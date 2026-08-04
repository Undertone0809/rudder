/**
 * Goal contract service.
 *
 * Reasoning:
 * - Contract/lifecycle changes are commands so a caller cannot silently turn
 *   a Goal into an achieved result by patching a legacy status column.
 * - Legacy hierarchy columns remain readable for existing issue/project links,
 *   but canonical Goals are top-level drafts with an explicit Owner and Plan.
 *
 * Traceability:
 * - doc/plans/2026-08-04-goal-system-refactor.md
 * - doc/product/domains/organizations-and-goals/goals-and-projects.md
 */
import type { Db } from "@rudderhq/db";
import {
  agents,
  automations,
  costEvents,
  financeEvents,
  goalActivities,
  goalOwnerAssignments,
  goalPlans,
  goals,
  heartbeatRuns,
  issues,
  projectGoals,
  projects,
} from "@rudderhq/db";
import type {
  ActivateGoal,
  AssignGoalOwner,
  CreateGoalActivity,
  EvaluateGoal,
  GoalDependencies,
  GoalDependencyPreview,
  GoalEvaluatorKind,
  UpdateGoalPlan,
} from "@rudderhq/shared";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";

type GoalRow = typeof goals.$inferSelect;
type GoalReader = Pick<Db, "select">;

const DEPENDENCY_PREVIEW_LIMIT = 5;
const TERMINAL_RUN_STATUSES = ["succeeded", "completed", "failed", "cancelled", "timed_out"] as const;

function countRows(rows: Array<{ count: unknown }>) {
  return Number(rows[0]?.count ?? 0);
}

function previewRows<T>(rows: T[], map: (row: T) => GoalDependencyPreview) {
  return rows.slice(0, DEPENDENCY_PREVIEW_LIMIT).map(map);
}

function assertCanonicalActiveGoal(goal: Pick<GoalRow, "lifecycle" | "ownerAgentId" | "outcomeStatement" | "criteria" | "planRevision" | "continuationKind" | "continuationSummary">) {
  if (goal.lifecycle !== "active") throw conflict("Only active Goals can receive this command");
  if (!goal.ownerAgentId || !goal.outcomeStatement?.trim() || !Array.isArray(goal.criteria) || goal.criteria.length === 0
    || goal.planRevision < 1 || !goal.continuationKind || !goal.continuationSummary?.trim()) {
    throw conflict("Goal requires Contract activation before this command");
  }
}

function assertGoalOwner(goal: Pick<GoalRow, "ownerAgentId">, actorAgentId: string | null) {
  if (actorAgentId && actorAgentId !== goal.ownerAgentId) {
    throw forbidden("Only the Goal Owner can perform this Agent command");
  }
}

async function assertOwnerBelongsToOrg(db: GoalReader, orgId: string, ownerAgentId: string) {
  const owner = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, ownerAgentId), eq(agents.orgId, orgId)))
    .then((rows) => rows[0] ?? null);
  if (!owner) throw unprocessable("Goal owner must belong to the same organization");
}

export async function getDefaultCompanyGoal(_db: GoalReader, _orgId: string): Promise<GoalRow | null> {
  // A Goal is a deliberate context reference now. New Issues must not inherit
  // a root Goal merely because one happens to exist in the organization.
  return null;
}

export async function getGoalDependencies(db: Db, goal: GoalRow): Promise<GoalDependencies> {
  const [childGoalRows, projectJoinRows, legacyProjectRows, issueRows, automationRows, costEventRows, financeEventRows] = await Promise.all([
    db.select({ id: goals.id, title: goals.title, status: goals.status }).from(goals)
      .where(and(eq(goals.orgId, goal.orgId), eq(goals.parentId, goal.id))).orderBy(asc(goals.createdAt)),
    db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projectGoals)
      .innerJoin(projects, eq(projectGoals.projectId, projects.id))
      .where(and(eq(projectGoals.orgId, goal.orgId), eq(projectGoals.goalId, goal.id))).orderBy(asc(projects.createdAt)),
    db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects)
      .where(and(eq(projects.orgId, goal.orgId), eq(projects.goalId, goal.id))).orderBy(asc(projects.createdAt)),
    db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status }).from(issues)
      .where(and(eq(issues.orgId, goal.orgId), eq(issues.goalId, goal.id))).orderBy(asc(issues.createdAt)),
    db.select({ id: automations.id, title: automations.title, status: automations.status }).from(automations)
      .where(and(eq(automations.orgId, goal.orgId), eq(automations.goalId, goal.id))).orderBy(asc(automations.createdAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(costEvents)
      .where(and(eq(costEvents.orgId, goal.orgId), eq(costEvents.goalId, goal.id))),
    db.select({ count: sql<number>`count(*)::int` }).from(financeEvents)
      .where(and(eq(financeEvents.orgId, goal.orgId), eq(financeEvents.goalId, goal.id))),
  ]);

  const linkedProjectsById = new Map<string, (typeof projectJoinRows)[number]>();
  for (const project of [...projectJoinRows, ...legacyProjectRows]) linkedProjectsById.set(project.id, project);
  const linkedProjects = [...linkedProjectsById.values()];
  const counts = {
    childGoals: childGoalRows.length,
    linkedProjects: linkedProjects.length,
    linkedIssues: issueRows.length,
    automations: automationRows.length,
    costEvents: countRows(costEventRows),
    financeEvents: countRows(financeEventRows),
  };
  const blockers = [
    ...(counts.childGoals > 0 ? ["child_goals"] : []),
    ...(counts.linkedProjects > 0 ? ["linked_projects"] : []),
    ...(counts.linkedIssues > 0 ? ["linked_issues"] : []),
    ...(counts.automations > 0 ? ["automations"] : []),
    ...(counts.costEvents > 0 ? ["cost_events"] : []),
    ...(counts.financeEvents > 0 ? ["finance_events"] : []),
  ];
  return {
    goalId: goal.id,
    orgId: goal.orgId,
    canDelete: blockers.length === 0 && goal.lifecycle === "draft",
    blockers: goal.lifecycle === "draft" ? blockers : [...blockers, "goal_not_draft"],
    isLastRootOrganizationGoal: false,
    counts,
    previews: {
      childGoals: previewRows(childGoalRows, (row) => ({ id: row.id, title: row.title, subtitle: row.status })),
      linkedProjects: previewRows(linkedProjects, (row) => ({ id: row.id, title: row.name, subtitle: row.status })),
      linkedIssues: previewRows(issueRows, (row) => ({ id: row.id, title: row.title, subtitle: row.identifier ?? row.status })),
      automations: previewRows(automationRows, (row) => ({ id: row.id, title: row.title, subtitle: row.status })),
    },
  };
}

async function requireGoal(db: GoalReader, id: string) {
  const goal = await db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null);
  if (!goal) throw notFound("Goal not found");
  return goal;
}

function positiveOutcome(mode: string, outcome: string) {
  return (mode === "target" && outcome === "achieved")
    || (mode === "maximize" && outcome === "completed_with_result")
    || (mode === "maintain" && outcome === "maintained")
    || (mode === "decide" && outcome === "decided");
}

export function reduceGoalEvaluation(goal: Pick<GoalRow, "objectiveMode" | "criteria">, input: EvaluateGoal) {
  const statuses = new Map(input.criteria.map((criterion) => [criterion.id, criterion.status]));
  const evidenceRefs = input.evidenceRefs;
  const hasReference = (reference: string) => evidenceRefs.some((evidence) => evidence === reference);
  const criterionStatuses = (goal.criteria as Array<{
    id: string;
    evaluator?: GoalEvaluatorKind;
    evidenceRequirements?: string[];
  }>).map((criterion) => {
    const requiredEvidence = criterion.evidenceRequirements ?? [];
    const missingEvidence = requiredEvidence.filter((reference) => !hasReference(reference));
    const evaluatorEvidenceSatisfied = criterion.evaluator === "metric"
      ? input.resultValue !== undefined
      : criterion.evaluator === "human"
        ? Boolean(input.decision?.trim() || input.resultPayload.humanApproval === true)
        : evidenceRefs.length > 0;
    const evidenceSatisfied = missingEvidence.length === 0 && evaluatorEvidenceSatisfied;
    const submittedStatus = statuses.get(criterion.id) ?? "unknown";
    return {
      id: criterion.id,
      evaluator: criterion.evaluator ?? null,
      status: submittedStatus === "met" && !evidenceSatisfied ? "unknown" : submittedStatus,
      evidenceSatisfied,
      missingEvidence,
    };
  });
  const has = (status: string) => criterionStatuses.some((criterion) => criterion.status === status);
  const allMet = criterionStatuses.length > 0 && criterionStatuses.every((criterion) => criterion.status === "met");
  const hasFailure = has("unmet") || has("breached");
  let outcome: string;
  switch (goal.objectiveMode) {
    case "target":
      outcome = hasFailure ? "not_achieved" : allMet ? "achieved" : "inconclusive";
      break;
    case "maximize":
      outcome = !hasFailure && allMet && input.resultValue !== undefined ? "completed_with_result" : "inconclusive";
      break;
    case "maintain":
      outcome = has("breached") ? "breached" : allMet ? "maintained" : "inconclusive";
      break;
    case "decide":
      outcome = !hasFailure && allMet && input.decision?.trim() ? "decided" : "inconclusive";
      break;
    default:
      outcome = "inconclusive";
  }
  return {
    mode: goal.objectiveMode,
    outcome,
    criteria: criterionStatuses,
    evidenceRefs: input.evidenceRefs,
    resultValue: input.resultValue,
    decision: input.decision ?? null,
    evaluatedAt: new Date().toISOString(),
  };
}

export function goalService(db: Db) {
  return {
    list: (orgId: string) => db.select().from(goals).where(eq(goals.orgId, orgId)).orderBy(asc(goals.createdAt)),

    getById: (id: string) => db.select().from(goals).where(eq(goals.id, id)).then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (orgId: string) => getDefaultCompanyGoal(db, orgId),

    dependencies: (goal: GoalRow) => getGoalDependencies(db, goal),

    detail: async (id: string) => {
      const goal = await requireGoal(db, id);
      const [ownerAssignment, plan, activities] = await Promise.all([
        db.select().from(goalOwnerAssignments).where(and(eq(goalOwnerAssignments.goalId, id), isNull(goalOwnerAssignments.endsAt)))
          .then((rows) => rows[0] ?? null),
        goal.planRevision > 0
          ? db.select().from(goalPlans).where(and(eq(goalPlans.goalId, id), eq(goalPlans.revision, goal.planRevision))).then((rows) => rows[0] ?? null)
          : Promise.resolve(null),
        db.select().from(goalActivities).where(eq(goalActivities.goalId, id)).orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(100),
      ]);
      return { ...goal, ownerAssignment, plan, activities };
    },

    create: async (orgId: string, data: { title: string; description?: string | null }) => db.insert(goals).values({
      orgId,
      title: data.title,
      description: data.description ?? null,
      level: "task",
      status: "planned",
      lifecycle: "draft",
      parentId: null,
      ownerAgentId: null,
    }).returning().then((rows) => rows[0]),

    update: async (id: string, data: { title?: string; description?: string | null }) => {
      await requireGoal(db, id);
      const { title, description } = data;
      return db.update(goals).set({ title, description, updatedAt: new Date() }).where(eq(goals.id, id)).returning().then((rows) => rows[0] ?? null);
    },

    activate: async (id: string, input: ActivateGoal, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      if (current.lifecycle !== "draft") throw conflict("Only draft Goals can be activated");
      if (actorAgentId && actorAgentId !== input.ownerAgentId) {
        throw forbidden("An Agent can only activate a Goal for itself as Owner");
      }
      await assertOwnerBelongsToOrg(db, current.orgId, input.ownerAgentId);
      const result = await db.transaction(async (tx) => {
        const [goal] = await tx.update(goals).set({
          outcomeStatement: input.outcomeStatement,
          objectiveMode: input.objectiveMode,
          lifecycle: "active",
          status: "active",
          contractRevision: 1,
          criteria: input.criteria,
          autonomyEnvelope: input.autonomyEnvelope,
          humanAuthorities: input.humanAuthorities,
          evaluationPolicy: input.evaluationPolicy,
          actionDeadline: input.actionDeadline ?? null,
          evaluationDeadline: input.evaluationDeadline ?? null,
          ownerAgentId: input.ownerAgentId,
          planRevision: 1,
          continuationKind: input.initialContinuation.kind,
          continuationSummary: input.initialContinuation.summary,
          wakeCondition: input.initialContinuation.wakeCondition ?? null,
          updatedAt: new Date(),
        }).where(and(eq(goals.id, id), eq(goals.lifecycle, "draft"))).returning();
        if (!goal) throw conflict("Goal changed before activation; reload and retry");
        await tx.insert(goalOwnerAssignments).values({
          orgId: current.orgId,
          goalId: id,
          agentId: input.ownerAgentId,
          assignedByAuthorityRef: "activation",
          assignmentRevision: 1,
        });
        await tx.insert(goalPlans).values({
          orgId: current.orgId,
          goalId: id,
          revision: 1,
          ...input.initialPlan,
          createdByAgentId: actorAgentId,
        });
        await tx.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: id,
          contractRevision: 1,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: input.ownerAgentId,
          activityKind: "progress",
          summary: `Goal activated with initial ${input.initialContinuation.kind}: ${input.initialContinuation.summary}`,
          evidenceRefs: [],
        });
        return goal;
      });
      return result;
    },

    updatePlan: async (id: string, input: UpdateGoalPlan, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      assertCanonicalActiveGoal(current);
      assertGoalOwner(current, actorAgentId);
      const revision = current.planRevision + 1;
      return db.transaction(async (tx) => {
        const [plan] = await tx.insert(goalPlans).values({
          orgId: current.orgId,
          goalId: id,
          revision,
          ...input,
          createdByAgentId: actorAgentId,
        }).returning();
        await tx.update(goals).set({ planRevision: revision, updatedAt: new Date() }).where(eq(goals.id, id));
        return plan;
      });
    },

    listActivities: (id: string) => db.select().from(goalActivities).where(eq(goalActivities.goalId, id))
      .orderBy(desc(goalActivities.occurredAt), desc(goalActivities.createdAt)).limit(100),

    createActivity: async (id: string, input: CreateGoalActivity, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      assertCanonicalActiveGoal(current);
      assertGoalOwner(current, actorAgentId);
      if (input.activityKind === "closeout" && !input.runRef) {
        throw unprocessable("A closeout Activity requires a Run reference");
      }
      if (input.runRef) {
        const run = await db.select({ id: heartbeatRuns.id, orgId: heartbeatRuns.orgId, status: heartbeatRuns.status })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runRef)).then((rows) => rows[0] ?? null);
        if (!run || run.orgId !== current.orgId) throw unprocessable("Goal Activity run must belong to the same organization");
        if (input.activityKind === "closeout" && !TERMINAL_RUN_STATUSES.includes(run.status as typeof TERMINAL_RUN_STATUSES[number])) {
          throw conflict("A closeout Activity requires a terminal Run");
        }
      }
      const [activity] = await db.insert(goalActivities).values({
        orgId: current.orgId,
        goalId: id,
        contractRevision: current.contractRevision,
        submittedByAgentId: actorAgentId,
        agentOwnerRefAtTime: current.ownerAgentId,
        activityKind: input.activityKind ?? "progress",
        commitmentRef: input.commitmentRef ?? null,
        runRef: input.runRef ?? null,
        summary: input.summary,
        evidenceRefs: input.evidenceRefs,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      }).onConflictDoNothing().returning();
      if (activity) return activity;
      if (input.activityKind === "closeout" && input.runRef) {
        const existingCloseout = await db.select().from(goalActivities).where(and(
          eq(goalActivities.goalId, id),
          eq(goalActivities.runRef, input.runRef),
          eq(goalActivities.activityKind, "closeout"),
        )).then((rows) => rows[0] ?? null);
        if (existingCloseout) throw conflict("A closeout Activity already exists for this Run");
      }
      if (input.idempotencyKey) {
        return db.select().from(goalActivities).where(and(eq(goalActivities.goalId, id), eq(goalActivities.idempotencyKey, input.idempotencyKey)))
          .then((rows) => rows[0] ?? null);
      }
      throw conflict("Goal Activity was already recorded");
    },

    assignOwner: async (id: string, input: AssignGoalOwner, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      assertCanonicalActiveGoal(current);
      assertGoalOwner(current, actorAgentId);
      await assertOwnerBelongsToOrg(db, current.orgId, input.agentId);
      return db.transaction(async (tx) => {
        const previous = await tx.select().from(goalOwnerAssignments)
          .where(and(eq(goalOwnerAssignments.goalId, id), isNull(goalOwnerAssignments.endsAt)))
          .then((rows) => rows[0] ?? null);
        if (previous?.agentId === input.agentId) return previous;
        const now = new Date();
        if (previous) await tx.update(goalOwnerAssignments).set({ endsAt: now }).where(eq(goalOwnerAssignments.id, previous.id));
        const [assignment] = await tx.insert(goalOwnerAssignments).values({
          orgId: current.orgId,
          goalId: id,
          agentId: input.agentId,
          assignmentRevision: (previous?.assignmentRevision ?? 0) + 1,
          assignedByAuthorityRef: input.authorityRef ?? null,
          startsAt: now,
        }).returning();
        await tx.update(goals).set({ ownerAgentId: input.agentId, updatedAt: now }).where(eq(goals.id, id));
        return assignment;
      });
    },

    setFocus: async (id: string, focus: boolean, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      if (focus) assertCanonicalActiveGoal(current);
      assertGoalOwner(current, actorAgentId);
      return db.transaction(async (tx) => {
        if (focus) await tx.update(goals).set({ focus: false }).where(eq(goals.orgId, current.orgId));
        const [goal] = await tx.update(goals).set({ focus, updatedAt: new Date() }).where(eq(goals.id, id)).returning();
        return goal;
      });
    },

    evaluate: async (id: string, input: EvaluateGoal, actorAgentId: string | null = null) => {
      const current = await requireGoal(db, id);
      assertCanonicalActiveGoal(current);
      assertGoalOwner(current, actorAgentId);
      const evaluation = reduceGoalEvaluation(current, input);
      const lifecycle = "closed" as const;
      const status = positiveOutcome(current.objectiveMode, evaluation.outcome) ? "achieved" : "cancelled";
      return db.transaction(async (tx) => {
        const [goal] = await tx.update(goals).set({
          lifecycle,
          status,
          closeReason: "evaluated",
          evaluationResult: evaluation,
          resultPayload: input.resultPayload,
          updatedAt: new Date(),
        }).where(and(eq(goals.id, id), eq(goals.lifecycle, "active"))).returning();
        if (!goal) throw conflict("Goal changed before evaluation; reload and retry");
        await tx.insert(goalActivities).values({
          orgId: current.orgId,
          goalId: id,
          contractRevision: current.contractRevision,
          submittedByAgentId: actorAgentId,
          agentOwnerRefAtTime: current.ownerAgentId,
          activityKind: "evidence",
          summary: `Goal evaluated as ${evaluation.outcome}`,
          evidenceRefs: input.evidenceRefs,
        });
        return goal;
      });
    },

    remove: async (id: string) => {
      const existing = await requireGoal(db, id);
      const dependencies = await getGoalDependencies(db, existing);
      if (!dependencies.canDelete) throw conflict("Only an unlinked draft Goal can be deleted", dependencies);
      return db.delete(goals).where(eq(goals.id, id)).returning().then((rows) => rows[0] ?? null);
    },
  };
}
