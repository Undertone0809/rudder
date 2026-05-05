import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agents, automations, costEvents, financeEvents, goals, issues, projectGoals, projects } from "@rudderhq/db";
import type { GoalDependencies, GoalDependencyPreview } from "@rudderhq/shared";
import { conflict, unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;
type GoalRow = typeof goals.$inferSelect;
type GoalInput = Omit<typeof goals.$inferInsert, "orgId">;
type GoalPatch = Partial<typeof goals.$inferInsert>;

const DEPENDENCY_PREVIEW_LIMIT = 5;

export async function getDefaultCompanyGoal(db: GoalReader, orgId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.orgId, orgId),
        eq(goals.level, "organization"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.orgId, orgId),
        eq(goals.level, "organization"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.orgId, orgId), eq(goals.level, "organization")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

function countRows(rows: Array<{ count: unknown }>) {
  return Number(rows[0]?.count ?? 0);
}

function previewRows<T>(
  rows: T[],
  map: (row: T) => GoalDependencyPreview,
) {
  return rows.slice(0, DEPENDENCY_PREVIEW_LIMIT).map(map);
}

async function assertOwnerBelongsToOrg(db: Db, orgId: string, ownerAgentId: string | null | undefined) {
  if (!ownerAgentId) return;
  const owner = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, ownerAgentId), eq(agents.orgId, orgId)))
    .then((rows) => rows[0] ?? null);
  if (!owner) {
    throw unprocessable("Goal owner must belong to the same organization");
  }
}

async function assertParentBelongsToOrgAndDoesNotCycle(
  db: Db,
  orgId: string,
  goalId: string | null,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  if (goalId && parentId === goalId) {
    throw unprocessable("Goal cannot be its own parent");
  }

  const allGoals = await db
    .select({ id: goals.id, orgId: goals.orgId, parentId: goals.parentId })
    .from(goals)
    .where(eq(goals.orgId, orgId));
  const parent = allGoals.find((goal) => goal.id === parentId);
  if (!parent) {
    throw unprocessable("Goal parent must belong to the same organization");
  }
  if (!goalId) return;

  const byId = new Map(allGoals.map((goal) => [goal.id, goal]));
  let cursor: string | null = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === goalId) {
      throw unprocessable("Goal parent cannot create a cycle");
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
}

async function assertGoalReferences(db: Db, orgId: string, goalId: string | null, data: GoalPatch) {
  if (data.ownerAgentId !== undefined) {
    await assertOwnerBelongsToOrg(db, orgId, data.ownerAgentId);
  }
  if (data.parentId !== undefined) {
    await assertParentBelongsToOrgAndDoesNotCycle(db, orgId, goalId, data.parentId);
  }
}

export async function getGoalDependencies(db: Db, goal: GoalRow): Promise<GoalDependencies> {
  const [
    childGoalRows,
    projectJoinRows,
    legacyProjectRows,
    issueRows,
    automationRows,
    costEventRows,
    financeEventRows,
    rootGoalRows,
  ] = await Promise.all([
    db
      .select({ id: goals.id, title: goals.title, status: goals.status })
      .from(goals)
      .where(and(eq(goals.orgId, goal.orgId), eq(goals.parentId, goal.id)))
      .orderBy(asc(goals.createdAt)),
    db
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projectGoals)
      .innerJoin(projects, eq(projectGoals.projectId, projects.id))
      .where(and(eq(projectGoals.orgId, goal.orgId), eq(projectGoals.goalId, goal.id)))
      .orderBy(asc(projects.createdAt)),
    db
      .select({ id: projects.id, name: projects.name, status: projects.status })
      .from(projects)
      .where(and(eq(projects.orgId, goal.orgId), eq(projects.goalId, goal.id)))
      .orderBy(asc(projects.createdAt)),
    db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
      .from(issues)
      .where(and(eq(issues.orgId, goal.orgId), eq(issues.goalId, goal.id)))
      .orderBy(asc(issues.createdAt)),
    db
      .select({ id: automations.id, title: automations.title, status: automations.status })
      .from(automations)
      .where(and(eq(automations.orgId, goal.orgId), eq(automations.goalId, goal.id)))
      .orderBy(asc(automations.createdAt)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(costEvents)
      .where(and(eq(costEvents.orgId, goal.orgId), eq(costEvents.goalId, goal.id))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(financeEvents)
      .where(and(eq(financeEvents.orgId, goal.orgId), eq(financeEvents.goalId, goal.id))),
    goal.level === "organization" && goal.parentId === null
      ? db
          .select({ count: sql<number>`count(*)::int` })
          .from(goals)
          .where(and(eq(goals.orgId, goal.orgId), eq(goals.level, "organization"), isNull(goals.parentId)))
      : Promise.resolve([{ count: 0 }]),
  ]);

  const linkedProjectsById = new Map<string, (typeof projectJoinRows)[number]>();
  for (const project of [...projectJoinRows, ...legacyProjectRows]) {
    linkedProjectsById.set(project.id, project);
  }
  const linkedProjects = [...linkedProjectsById.values()];
  const counts = {
    childGoals: childGoalRows.length,
    linkedProjects: linkedProjects.length,
    linkedIssues: issueRows.length,
    automations: automationRows.length,
    costEvents: countRows(costEventRows),
    financeEvents: countRows(financeEventRows),
  };
  const isLastRootOrganizationGoal =
    goal.level === "organization" &&
    goal.parentId === null &&
    countRows(rootGoalRows) <= 1;
  const blockers = [
    ...(isLastRootOrganizationGoal ? ["last_root_organization_goal"] : []),
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
    canDelete: blockers.length === 0,
    blockers,
    isLastRootOrganizationGoal,
    counts,
    previews: {
      childGoals: previewRows(childGoalRows, (row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.status,
      })),
      linkedProjects: previewRows(linkedProjects, (row) => ({
        id: row.id,
        title: row.name,
        subtitle: row.status,
      })),
      linkedIssues: previewRows(issueRows, (row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.identifier ?? row.status,
      })),
      automations: previewRows(automationRows, (row) => ({
        id: row.id,
        title: row.title,
        subtitle: row.status,
      })),
    },
  };
}

export function goalService(db: Db) {
  return {
    list: (orgId: string) => db.select().from(goals).where(eq(goals.orgId, orgId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (orgId: string) => getDefaultCompanyGoal(db, orgId),

    dependencies: (goal: GoalRow) => getGoalDependencies(db, goal),

    create: async (orgId: string, data: GoalInput) => {
      await assertGoalReferences(db, orgId, null, data);
      return db
        .insert(goals)
        .values({ ...data, orgId })
        .returning()
        .then((rows) => rows[0]);
    },

    update: async (id: string, data: GoalPatch) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      await assertGoalReferences(db, existing.orgId, id, data);
      return db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: async (id: string) => {
      const existing = await db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;
      const dependencies = await getGoalDependencies(db, existing);
      if (!dependencies.canDelete) {
        throw conflict("Goal cannot be deleted while it has dependencies", dependencies);
      }
      return db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },
  };
}
