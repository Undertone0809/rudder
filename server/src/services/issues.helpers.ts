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
  type IssueSearchMatch,
  type ReorderIssue,
} from "@rudderhq/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getDefaultCompanyGoal } from "./goals.js";


export const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
export const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const BOARD_ORDER_STEP = 1000;

export function isUniqueConstraintConflict(error: unknown, constraintName: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505" &&
    "constraint" in error &&
    (error as { constraint?: unknown }).constraint === constraintName
  );
}

export function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

export function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  participantAgentId?: string;
  assigneeUserId?: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  excludeReviewerConfirmedBlockedHandoff?: boolean;
  touchedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  parentId?: string;
  labelId?: string;
  originKind?: string;
  originId?: string;
  includeAutomationExecutions?: boolean;
  q?: string;
}

export type IssueRow = typeof issues.$inferSelect;
export type IssueLabelRow = typeof labels.$inferSelect;
export type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
export type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
export type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
export type IssueWithSearchMatch = IssueWithLabelsAndRun & { searchMatch?: IssueSearchMatch | null };
export type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
export type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  reviewerUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function textContains(value: string | null | undefined, query: string): value is string {
  return Boolean(value && value.toLowerCase().includes(query.toLowerCase()));
}

export function buildSearchSnippet(value: string, query: string, maxLength = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;

  const index = compact.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return `${compact.slice(0, maxLength - 1).trimEnd()}…`;

  const context = Math.max(20, Math.floor((maxLength - query.length) / 2));
  const start = Math.max(0, index - context);
  const end = Math.min(compact.length, start + maxLength);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < compact.length ? "…" : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}

export function fieldSearchMatch(row: IssueRow, query: string): IssueSearchMatch | null {
  if (textContains(row.identifier, query)) {
    return { field: "identifier", snippet: buildSearchSnippet(row.identifier, query) };
  }
  if (textContains(row.title, query)) {
    return { field: "title", snippet: buildSearchSnippet(row.title, query) };
  }
  if (textContains(row.description, query)) {
    return { field: "description", snippet: buildSearchSnippet(row.description, query) };
  }
  return null;
}

export function touchedByUserCondition(orgId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR ${issues.reviewerUserId} = ${userId}
      OR ${followedByUserCondition(orgId, userId)}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.orgId} = ${orgId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.orgId} = ${orgId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

export function followedByUserCondition(orgId: string, userId: string) {
  return sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${issueFollows}
      WHERE ${issueFollows.issueId} = ${issues.id}
        AND ${issueFollows.orgId} = ${orgId}
        AND ${issueFollows.userId} = ${userId}
    )
  `;
}

export function participatedByAgentCondition(orgId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR ${issues.reviewerAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.orgId} = ${orgId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.orgId} = ${orgId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

export function myLastCommentAtExpr(orgId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.orgId} = ${orgId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

export function myLastReadAtExpr(orgId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.orgId} = ${orgId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

export function myLastTouchAtExpr(orgId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(orgId, userId);
  const myLastReadAt = myLastReadAtExpr(orgId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.reviewerUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

export function unreadForUserCondition(orgId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(orgId, userId);
  const myLastTouchAt = myLastTouchAtExpr(orgId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.orgId} = ${orgId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const reviewerTouchAt = issue.reviewerUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt, reviewerTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

export async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      issueId: issueLabels.issueId,
      label: labels,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.issueId);
    if (existing) existing.push(row.label);
    else map.set(row.issueId, [row.label]);
  }
  return map;
}

export async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

export const ACTIVE_RUN_STATUSES = ["queued", "running"];

export async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  const rows = await dbOrTx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.id, runIds),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );

  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

export function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}
