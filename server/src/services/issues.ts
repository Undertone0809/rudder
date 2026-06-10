import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agents,
  assets,
  organizations,
  organizationMemberships,
  documents,
  goals,
  heartbeatRuns,
  executionWorkspaces,
  issueAttachments,
  issueFollows,
  issueLabels,
  issueComments,
  issueDocuments,
  issueReadStates,
  issues,
  labels,
  projectWorkspaces,
  projects,
} from "@rudderhq/db";
import {
  extractAgentMentionIds,
  extractProjectMentionIds,
  isUuidLike,
  type IssueSearchField,
  type IssueSearchMatch,
  type ReorderIssue,
} from "@rudderhq/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { issueMaterialUpdateActivitySql } from "./issue-activity-filters.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";

import {
  ALL_ISSUE_STATUSES,
  MAX_ISSUE_COMMENT_PAGE_LIMIT,
  BOARD_ORDER_STEP,
  isUniqueConstraintConflict,
  assertTransition,
  applyStatusSideEffects,
  sameRunLock,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  escapeLikePattern,
  textContains,
  buildSearchSnippet,
  fieldSearchMatch,
  touchedByUserCondition,
  participatedByAgentCondition,
  myLastCommentAtExpr,
  myLastReadAtExpr,
  myLastTouchAtExpr,
  unreadForUserCondition,
  followedByUserCondition,
  deriveIssueUserContext,
  labelMapForIssues,
  withIssueLabels,
  ACTIVE_RUN_STATUSES,
  activeRunMapForIssues,
  withActiveRuns,
  type IssueRow,
  type IssueLabelRow,
  type IssueWithLabels,
  type IssueWithLabelsAndRun,
  type IssueActiveRunRow,
  type IssueFilters,
  type IssueWithSearchMatch,
} from "./issues.helpers.js";
import { createIssueCommentAttachmentMethods } from "./issues.comments-attachments.js";
export type { IssueFilters } from "./issues.helpers.js";
export { deriveIssueUserContext } from "./issues.helpers.js";

const DEFAULT_ISSUE_SEARCH_FIELDS: IssueSearchField[] = ["title"];

function normalizeIssueSearchFields(fields: IssueSearchField[] | undefined): Set<IssueSearchField> {
  const allowed = new Set<IssueSearchField>(["title", "description", "comment"]);
  const normalized = (fields ?? DEFAULT_ISSUE_SEARCH_FIELDS).filter((field): field is IssueSearchField => allowed.has(field));
  return new Set(normalized.length > 0 ? normalized : DEFAULT_ISSUE_SEARCH_FIELDS);
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function assertIssueAgentPrincipal(orgId: string, agentId: string, label: "Assignee" | "Reviewer") {
    const principal = await db
      .select({
        id: agents.id,
        orgId: agents.orgId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!principal) throw notFound(`${label} agent not found`);
    if (principal.orgId !== orgId) {
      throw unprocessable(`${label} must belong to same organization`);
    }
    if (principal.status === "pending_approval") {
      throw conflict(`Cannot ${label === "Assignee" ? "assign work to" : "select"} pending approval agents`);
    }
    if (principal.status === "terminated") {
      throw conflict(`Cannot ${label === "Assignee" ? "assign work to" : "select"} terminated agents`);
    }
  }

  async function assertIssueUserPrincipal(orgId: string, userId: string, label: "Assignee" | "Reviewer") {
    const membership = await db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgId, orgId),
          eq(organizationMemberships.principalType, "user"),
          eq(organizationMemberships.principalId, userId),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound(`${label} user not found`);
    }
  }

  async function assertAssignableAgent(orgId: string, agentId: string) {
    await assertIssueAgentPrincipal(orgId, agentId, "Assignee");
  }

  async function assertAssignableUser(orgId: string, userId: string) {
    await assertIssueUserPrincipal(orgId, userId, "Assignee");
  }

  async function assertReviewerAgent(orgId: string, agentId: string) {
    await assertIssueAgentPrincipal(orgId, agentId, "Reviewer");
  }

  async function assertReviewerUser(orgId: string, userId: string) {
    await assertIssueUserPrincipal(orgId, userId, "Reviewer");
  }

  async function assertValidProjectWorkspace(orgId: string, projectId: string | null | undefined, projectWorkspaceId: string) {
    const workspace = await db
      .select({
        id: projectWorkspaces.id,
        orgId: projectWorkspaces.orgId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.orgId !== orgId) throw unprocessable("Project workspace must belong to same organization");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
  }

  async function assertValidGoal(orgId: string, goalId: string | null | undefined) {
    if (!goalId) return;
    const goal = await db
      .select({ id: goals.id, orgId: goals.orgId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.orgId !== orgId) {
      throw unprocessable("Goal must belong to same organization");
    }
  }

  async function assertValidExecutionWorkspace(orgId: string, projectId: string | null | undefined, executionWorkspaceId: string) {
    const workspace = await db
      .select({
        id: executionWorkspaces.id,
        orgId: executionWorkspaces.orgId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.orgId !== orgId) throw unprocessable("Execution workspace must belong to same organization");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
  }

  async function assertValidLabelIds(orgId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.orgId, orgId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this organization");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    orgId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(orgId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        orgId,
      })),
    );
  }

  async function resolveCreateLabelIds(
    orgId: string,
    data: Pick<typeof issues.$inferInsert, "createdByAgentId" | "parentId">,
    inputLabelIds: string[] | undefined,
    dbOrTx: any,
  ) {
    if (inputLabelIds && inputLabelIds.length > 0) return inputLabelIds;

    if (data.parentId) {
      const parentLabelRows = await dbOrTx
        .select({ labelId: issueLabels.labelId })
        .from(issueLabels)
        .innerJoin(issues, eq(issueLabels.issueId, issues.id))
        .where(and(eq(issues.id, data.parentId), eq(issues.orgId, orgId), eq(issueLabels.orgId, orgId)))
        .orderBy(asc(issueLabels.labelId));
      if (parentLabelRows.length > 0) {
        return parentLabelRows.map((row: { labelId: string }) => row.labelId);
      }
    }

    if (!data.createdByAgentId) return inputLabelIds;

    const [labelCountRow] = await dbOrTx
      .select({ count: sql<number>`count(*)` })
      .from(labels)
      .where(eq(labels.orgId, orgId));
    const labelCount = Number(labelCountRow?.count ?? 0);
    if (labelCount < 5) return inputLabelIds;

    throw unprocessable(
      `当前组织有 ${labelCount} 个 labels，agent 创建 issue 需要选择至少一个 label`,
      {
        code: "agent_issue_label_required",
        labelCount,
      },
    );
  }

  async function assertValidParentIssue(
    orgId: string,
    issueId: string | null,
    parentId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!parentId) return;
    if (issueId && parentId === issueId) {
      throw unprocessable("Issue cannot be its own parent");
    }

    const parent = await dbOrTx
      .select({ id: issues.id, orgId: issues.orgId, parentId: issues.parentId, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, parentId))
      .then(
        (rows: Array<{ id: string; orgId: string; parentId: string | null; projectId: string | null }>) =>
          rows[0] ?? null,
      );

    if (!parent || parent.orgId !== orgId) {
      throw unprocessable("Parent issue must belong to the same organization");
    }

    if (!issueId) return parent;

    const visited = new Set<string>();
    let currentParentId: string | null = parent.parentId ?? null;
    while (currentParentId) {
      if (currentParentId === issueId) {
        throw unprocessable("Issue parent cannot be one of its descendants");
      }
      if (visited.has(currentParentId)) {
        throw unprocessable("Issue parent chain contains a cycle");
      }
      visited.add(currentParentId);

      const next = await dbOrTx
        .select({ parentId: issues.parentId })
        .from(issues)
        .where(and(eq(issues.id, currentParentId), eq(issues.orgId, orgId)))
        .then((rows: Array<{ parentId: string | null }>) => rows[0] ?? null);
      currentParentId = next?.parentId ?? null;
    }
    return parent;
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingHeartbeatRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  async function attachSearchMatches(
    orgId: string,
    rows: IssueWithLabelsAndRun[],
    query: string,
    containsPattern: string,
    searchFields: ReadonlySet<IssueSearchField>,
  ): Promise<IssueWithSearchMatch[]> {
    if (rows.length === 0) return [];

    const matchesByIssueId = new Map<string, IssueSearchMatch>();
    for (const row of rows) {
      const match = fieldSearchMatch(row, query, searchFields);
      if (match) matchesByIssueId.set(row.id, match);
    }

    const commentMatchedIssueIds = rows
      .map((row) => row.id)
      .filter((id) => !matchesByIssueId.has(id));
    if (searchFields.has("comment") && commentMatchedIssueIds.length > 0) {
      const commentRows = await db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.orgId, orgId),
            inArray(issueComments.issueId, commentMatchedIssueIds),
            isNull(issueComments.deletedAt),
            sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
          ),
        )
        .orderBy(asc(issueComments.createdAt));

      for (const comment of commentRows) {
        if (matchesByIssueId.has(comment.issueId)) continue;
        matchesByIssueId.set(comment.issueId, {
          field: "comment",
          snippet: buildSearchSnippet(comment.body, query),
          commentId: comment.id,
        });
      }
    }

    return rows.map((row) => ({
      ...row,
      searchMatch: matchesByIssueId.get(row.id) ?? null,
    }));
  }

  return {
    listFollows: async (orgId: string, userId: string) => {
      const rows = await db
        .select({
          id: issueFollows.id,
          orgId: issueFollows.orgId,
          issueId: issueFollows.issueId,
          userId: issueFollows.userId,
          createdAt: issueFollows.createdAt,
          issue: {
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
            reviewerUserId: issues.reviewerUserId,
            createdByUserId: issues.createdByUserId,
            updatedAt: issues.updatedAt,
          },
        })
        .from(issueFollows)
        .innerJoin(issues, eq(issueFollows.issueId, issues.id))
        .where(and(eq(issueFollows.orgId, orgId), eq(issueFollows.userId, userId), isNull(issues.hiddenAt)))
        .orderBy(desc(issueFollows.createdAt));
      return rows;
    },

    followIssue: async (orgId: string, issueId: string, userId: string) => {
      const issue = await db
        .select({ id: issues.id, orgId: issues.orgId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.orgId, orgId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const now = new Date();
      const [row] = await db
        .insert(issueFollows)
        .values({
          orgId,
          issueId,
          userId,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [issueFollows.orgId, issueFollows.issueId, issueFollows.userId],
          set: { createdAt: now },
        })
        .returning();
      return row;
    },

    unfollowIssue: async (orgId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueFollows)
        .where(and(eq(issueFollows.orgId, orgId), eq(issueFollows.issueId, issueId), eq(issueFollows.userId, userId)))
        .returning();
      return row ?? null;
    },

    isFollowedByUser: async (orgId: string, issueId: string, userId: string) => {
      const row = await db
        .select({ id: issueFollows.id })
        .from(issueFollows)
        .where(and(eq(issueFollows.orgId, orgId), eq(issueFollows.issueId, issueId), eq(issueFollows.userId, userId)))
        .then((rows) => rows[0] ?? null);
      return Boolean(row);
    },

    list: async (orgId: string, filters?: IssueFilters) => {
      const conditions = [eq(issues.orgId, orgId)];
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const searchFields = normalizeIssueSearchFields(filters?.searchFields);
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.orgId} = ${orgId}
            AND ${issueComments.deletedAt} IS NULL
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s: string) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(orgId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (filters?.reviewerAgentId) {
        conditions.push(eq(issues.reviewerAgentId, filters.reviewerAgentId));
      }
      if (filters?.excludeReviewerConfirmedBlockedHandoff && filters?.reviewerAgentId) {
        conditions.push(sql<boolean>`
          NOT (
            ${issues.status} = 'blocked'
            AND EXISTS (
              SELECT 1
              FROM activity_log confirmed_blocked_review
              WHERE confirmed_blocked_review.org_id = ${orgId}
                AND confirmed_blocked_review.entity_type = 'issue'
                AND confirmed_blocked_review.entity_id = ${issues.id}::text
                AND confirmed_blocked_review.action = 'issue.review_decision_recorded'
                AND confirmed_blocked_review.actor_type = 'agent'
                AND confirmed_blocked_review.actor_id = ${filters.reviewerAgentId}::text
                AND confirmed_blocked_review.details ->> 'decision' = 'blocked'
                AND confirmed_blocked_review.created_at >= COALESCE((
                  SELECT MAX(material_activity.created_at)
                  FROM activity_log material_activity
                  WHERE material_activity.org_id = ${orgId}
                    AND material_activity.entity_type = 'issue'
                    AND material_activity.entity_id = ${issues.id}::text
                    AND (
                      ${issueMaterialUpdateActivitySql("material_activity")}
                      OR (
                        material_activity.action = 'issue.comment_added'
                        AND NOT (
                          material_activity.actor_type = 'agent'
                          AND material_activity.actor_id = ${filters.reviewerAgentId}::text
                        )
                      )
                    )
                ), to_timestamp(0))
            )
          )
        `);
      }
      if (filters?.reviewerUserId) {
        conditions.push(eq(issues.reviewerUserId, filters.reviewerUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(orgId, touchedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(orgId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.orgId, orgId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        const searchConditions = [];
        if (searchFields.has("title")) searchConditions.push(titleContainsMatch);
        if (searchFields.has("description")) searchConditions.push(descriptionContainsMatch);
        if (searchFields.has("comment")) searchConditions.push(commentContainsMatch);
        conditions.push(or(...searchConditions)!);
      }
      if (!filters?.includeAutomationExecutions && !filters?.originKind && !filters?.originId) {
        conditions.push(contextUserId
          ? or(ne(issues.originKind, "automation_execution"), followedByUserCondition(orgId, contextUserId))!
          : ne(issues.originKind, "automation_execution"));
      }
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${searchFields.has("title")} AND ${titleStartsWithMatch} THEN 0
          WHEN ${searchFields.has("title")} AND ${titleContainsMatch} THEN 1
          WHEN ${searchFields.has("description")} AND ${descriptionContainsMatch} THEN 2
          WHEN ${searchFields.has("comment")} AND ${commentContainsMatch} THEN 3
          ELSE 6
        END
      `;
      const rows = await db
        .select()
        .from(issues)
        .where(and(...conditions))
        .orderBy(hasSearch ? asc(searchOrder) : asc(priorityOrder), asc(priorityOrder), desc(issues.updatedAt));
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      const withSearchMatches = hasSearch
        ? await attachSearchMatches(orgId, withRuns, rawSearch, containsPattern, searchFields)
        : withRuns;
      if (!contextUserId || withSearchMatches.length === 0) {
        return withSearchMatches;
      }

      const issueIds = withSearchMatches.map((row) => row.id);
      const statsRows = await db
        .select({
          issueId: issueComments.issueId,
          myLastCommentAt: sql<Date | null>`
            MAX(CASE WHEN ${issueComments.authorUserId} = ${contextUserId} THEN ${issueComments.createdAt} END)
          `,
          lastExternalCommentAt: sql<Date | null>`
            MAX(
              CASE
                WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${contextUserId}
                THEN ${issueComments.createdAt}
              END
            )
          `,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.orgId, orgId),
            inArray(issueComments.issueId, issueIds),
            isNull(issueComments.deletedAt),
          ),
        )
        .groupBy(issueComments.issueId);
      const readRows = await db
        .select({
          issueId: issueReadStates.issueId,
          myLastReadAt: issueReadStates.lastReadAt,
        })
        .from(issueReadStates)
        .where(
          and(
            eq(issueReadStates.orgId, orgId),
            eq(issueReadStates.userId, contextUserId),
            inArray(issueReadStates.issueId, issueIds),
          ),
        );
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withSearchMatches.map((row) => ({
        ...row,
        ...deriveIssueUserContext(row, contextUserId, {
          myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
          myLastReadAt: readByIssueId.get(row.id) ?? null,
          lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
        }),
      }));
    },

    countUnreadTouchedByUser: async (orgId: string, userId: string, status?: string) => {
      const conditions = [
        eq(issues.orgId, orgId),
        isNull(issues.hiddenAt),
        unreadForUserCondition(orgId, userId),
        or(ne(issues.originKind, "automation_execution"), followedByUserCondition(orgId, userId))!,
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (orgId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          orgId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.orgId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    getByIdentifier: async (identifier: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.identifier, identifier.toUpperCase()))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    create: async (
      orgId: string,
      data: Omit<typeof issues.$inferInsert, "orgId"> & { labelIds?: string[] },
    ) => {
      const { labelIds: inputLabelIds, ...rawIssueData } = data;
      const issueData = { ...rawIssueData };
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(orgId, data.assigneeAgentId);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(orgId, data.assigneeUserId);
      }
      if (data.reviewerAgentId && data.reviewerUserId) {
        throw unprocessable("Issue can only have one reviewer");
      }
      if (data.reviewerAgentId) {
        await assertReviewerAgent(orgId, data.reviewerAgentId);
      }
      if (data.reviewerUserId) {
        await assertReviewerUser(orgId, data.reviewerUserId);
      }
      if (data.goalId) {
        await assertValidGoal(orgId, data.goalId);
      }
      const parentIssue = await assertValidParentIssue(orgId, null, issueData.parentId);
      if (issueData.parentId && issueData.projectId === undefined && parentIssue?.projectId) {
        issueData.projectId = parentIssue.projectId;
      }
      if (issueData.projectWorkspaceId) {
        await assertValidProjectWorkspace(orgId, issueData.projectId, issueData.projectWorkspaceId);
      }
      if (issueData.executionWorkspaceId) {
        await assertValidExecutionWorkspace(orgId, issueData.projectId, issueData.executionWorkspaceId);
      }
      if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, orgId);
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        if (executionWorkspaceSettings == null && issueData.projectId) {
          const project = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.orgId, orgId)))
            .then((rows) => rows[0] ?? null);
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy),
            ) as Record<string, unknown> | null;
        }
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        if (!projectWorkspaceId && issueData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.orgId, orgId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.orgId, orgId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        const [organization] = await tx
          .update(organizations)
          .set({ issueCounter: sql`${organizations.issueCounter} + 1` })
          .where(eq(organizations.id, orgId))
          .returning({ issueCounter: organizations.issueCounter, issuePrefix: organizations.issuePrefix });

        const issueNumber = organization.issueCounter;
        const identifier = `${organization.issuePrefix}-${issueNumber}`;

        const values = {
          ...issueData,
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId: issueData.projectId,
            goalId: issueData.goalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          orgId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }
        if (values.boardOrder === undefined) {
          const statusForOrder = values.status ?? "backlog";
          const currentMax = await tx
            .select({ value: sql<number>`coalesce(max(${issues.boardOrder}), 0)` })
            .from(issues)
            .where(and(eq(issues.orgId, orgId), eq(issues.status, statusForOrder)))
            .then((rows) => Number(rows[0]?.value ?? 0));
          values.boardOrder = currentMax + BOARD_ORDER_STEP;
        }

        const resolvedLabelIds = await resolveCreateLabelIds(orgId, issueData, inputLabelIds, tx);
        const [issue] = await tx.insert(issues).values(values).returning();
        if (resolvedLabelIds) {
          await syncIssueLabels(issue.id, orgId, resolvedLabelIds, tx);
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
      });
    },

    update: async (id: string, data: Partial<typeof issues.$inferInsert> & { labelIds?: string[] }) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const { labelIds: nextLabelIds, ...issueData } = data;

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;
      const nextReviewerAgentId =
        issueData.reviewerAgentId !== undefined ? issueData.reviewerAgentId : existing.reviewerAgentId;
      const nextReviewerUserId =
        issueData.reviewerUserId !== undefined ? issueData.reviewerUserId : existing.reviewerUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (nextReviewerAgentId && nextReviewerUserId) {
        throw unprocessable("Issue can only have one reviewer");
      }
      if (patch.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.orgId, issueData.assigneeAgentId);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.orgId, issueData.assigneeUserId);
      }
      if (issueData.reviewerAgentId) {
        await assertReviewerAgent(existing.orgId, issueData.reviewerAgentId);
      }
      if (issueData.reviewerUserId) {
        await assertReviewerUser(existing.orgId, issueData.reviewerUserId);
      }
      if (issueData.goalId) {
        await assertValidGoal(existing.orgId, issueData.goalId);
      }
      const projectChanged = issueData.projectId !== undefined && issueData.projectId !== existing.projectId;
      if (projectChanged) {
        if (issueData.projectWorkspaceId === undefined) {
          patch.projectWorkspaceId = null;
        }
        if (issueData.executionWorkspaceId === undefined) {
          patch.executionWorkspaceId = null;
        }
      }
      const nextProjectId = issueData.projectId !== undefined ? issueData.projectId : existing.projectId;
      const nextProjectWorkspaceId =
        patch.projectWorkspaceId !== undefined ? patch.projectWorkspaceId : existing.projectWorkspaceId;
      const nextExecutionWorkspaceId =
        patch.executionWorkspaceId !== undefined ? patch.executionWorkspaceId : existing.executionWorkspaceId;
      if (nextProjectWorkspaceId) {
        await assertValidProjectWorkspace(existing.orgId, nextProjectId, nextProjectWorkspaceId);
      }
      if (nextExecutionWorkspaceId) {
        await assertValidExecutionWorkspace(existing.orgId, nextProjectId, nextExecutionWorkspaceId);
      }
      if (issueData.parentId !== undefined) {
        await assertValidParentIssue(existing.orgId, existing.id, issueData.parentId);
      }

      applyStatusSideEffects(issueData.status, patch);
      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      return db.transaction(async (tx) => {
        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, existing.orgId);
        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: existing.projectId,
          currentGoalId: existing.goalId,
          projectId: issueData.projectId,
          goalId: issueData.goalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.orgId, nextLabelIds, tx);
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      });
    },

    reorder: async (orgId: string, input: ReorderIssue) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.orgId, orgId)))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        assertTransition(existing.status, input.targetStatus);

        const targetRows = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.orgId, orgId),
              eq(issues.status, input.targetStatus),
              ne(issues.id, input.issueId),
              isNull(issues.hiddenAt),
            ),
          )
          .orderBy(asc(issues.boardOrder), desc(issues.updatedAt), desc(issues.createdAt), asc(issues.id));

        const targetIds = new Set(targetRows.map((row) => row.id));
        if (input.previousIssueId && !targetIds.has(input.previousIssueId)) {
          throw unprocessable("previousIssueId must belong to the target status lane");
        }
        if (input.nextIssueId && !targetIds.has(input.nextIssueId)) {
          throw unprocessable("nextIssueId must belong to the target status lane");
        }

        let insertIndex = input.position === "start" ? 0 : targetRows.length;
        const previousIndex = input.previousIssueId
          ? targetRows.findIndex((row) => row.id === input.previousIssueId)
          : -1;
        const nextIndex = input.nextIssueId
          ? targetRows.findIndex((row) => row.id === input.nextIssueId)
          : -1;

        if (previousIndex >= 0 && nextIndex >= 0) {
          if (nextIndex !== previousIndex + 1) {
            throw unprocessable("previousIssueId and nextIssueId must be adjacent in the target lane");
          }
          insertIndex = nextIndex;
        } else if (previousIndex >= 0) {
          insertIndex = previousIndex + 1;
        } else if (nextIndex >= 0) {
          insertIndex = nextIndex;
        }

        const orderedRows: IssueRow[] = [...targetRows];
        orderedRows.splice(insertIndex, 0, existing);

        const now = new Date();
        let updatedIssue: IssueRow | null = null;
        for (const [index, row] of orderedRows.entries()) {
          const nextOrder = (index + 1) * BOARD_ORDER_STEP;
          if (row.id === existing.id) {
            const patch: Partial<typeof issues.$inferInsert> = {
              boardOrder: nextOrder,
            };
            if (existing.status !== input.targetStatus) {
              patch.status = input.targetStatus;
              patch.updatedAt = now;
              applyStatusSideEffects(input.targetStatus, patch);
              if (input.targetStatus !== "done") {
                patch.completedAt = null;
              }
              if (input.targetStatus !== "cancelled") {
                patch.cancelledAt = null;
              }
              if (input.targetStatus !== "in_progress") {
                patch.checkoutRunId = null;
                patch.executionRunId = null;
                patch.executionAgentNameKey = null;
                patch.executionLockedAt = null;
              }
            }

            updatedIssue = await tx
              .update(issues)
              .set(patch)
              .where(and(eq(issues.id, row.id), eq(issues.orgId, orgId)))
              .returning()
              .then((rows) => rows[0] ?? null);
            continue;
          }

          if (row.boardOrder === nextOrder) continue;
          await tx
            .update(issues)
            .set({ boardOrder: nextOrder })
            .where(and(eq(issues.id, row.id), eq(issues.orgId, orgId)));
        }

        if (!updatedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [updatedIssue]);
        return {
          issue: enriched,
          previousStatus: existing.status,
          previousBoardOrder: existing.boardOrder,
        };
      }),

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        await tx.delete(issueReadStates).where(eq(issueReadStates.issueId, id));
        await tx.delete(issueComments).where(eq(issueComments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (id: string, agentId: string, expectedStatuses: string[], checkoutRunId: string | null) => {
      const issueCompany = await db
        .select({ orgId: issues.orgId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.orgId, agentId);

      const now = new Date();
      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, expectedStatuses),
            or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        current.executionRunId === actorRunId
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        throw conflict("Only checkout run can release issue", {
          issueId: existing.id,
          assigneeAgentId: existing.assigneeAgentId,
          checkoutRunId: existing.checkoutRunId,
          actorRunId: actorRunId ?? null,
        });
      }

      const updated = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (orgId: string) =>
      db.select().from(labels).where(eq(labels.orgId, orgId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (orgId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      try {
        const [created] = await db
          .insert(labels)
          .values({
            orgId,
            name: data.name.trim(),
            color: data.color,
          })
          .returning();
        return created;
      } catch (error) {
        if (isUniqueConstraintConflict(error, "labels_company_name_idx")) {
          throw conflict(`Label already exists: ${data.name.trim()}`);
        }
        throw error;
      }
    },

    updateLabel: async (id: string, data: Partial<Pick<typeof labels.$inferInsert, "name" | "color">>) => {
      const existing = await db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null);
      if (!existing) return null;

      const patch: Partial<typeof labels.$inferInsert> = {};
      if (typeof data.name === "string") patch.name = data.name.trim();
      if (typeof data.color === "string") patch.color = data.color;
      if (Object.keys(patch).length === 0) return existing;

      try {
        const [updated] = await db
          .update(labels)
          .set({
            ...patch,
            updatedAt: new Date(),
          })
          .where(eq(labels.id, id))
          .returning();
        return updated ?? null;
      } catch (error) {
        if (isUniqueConstraintConflict(error, "labels_company_name_idx")) {
          throw conflict(`Label already exists: ${patch.name ?? existing.name}`);
        }
        throw error;
      }
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    ...createIssueCommentAttachmentMethods({ db, instanceSettings, redactIssueComment }),

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; assigneeUserId: string | null;
        reviewerAgentId: string | null; reviewerUserId: string | null;
        projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
          reviewerAgentId: issues.reviewerAgentId, reviewerUserId: issues.reviewerUserId,
          projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          assigneeUserId: parent.assigneeUserId ?? null,
          reviewerAgentId: parent.reviewerAgentId ?? null,
          reviewerUserId: parent.reviewerUserId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          orgId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          orgId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            orgId: workspace.orgId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
