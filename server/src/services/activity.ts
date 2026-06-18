import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  chatContextLinks,
  chatConversations,
  chatMessages,
  heartbeatRuns,
  issueComments,
  issues,
  operatorProfiles,
} from "@rudderhq/db";
import {
  isLowSignalIssueContentOnlyUpdate,
  type UserActivityLedgerInclude,
  type UserActivityLedgerItem,
  type UserActivityLedgerKind,
} from "@rudderhq/shared";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { badRequest } from "../errors.js";
import { issueLowSignalContentOnlyActivitySql } from "./issue-activity-filters.js";

export interface ActivityFilters {
  orgId: string;
  agentId?: string;
  userId?: string;
  actorType?: "agent" | "user" | "system";
  actorId?: string;
  entityType?: string;
  entityId?: string;
}

export interface ActivityPageFilters extends ActivityFilters {
  limit?: number;
  cursor?: string | null;
}

export interface UserActivityLedgerFilters {
  orgId: string;
  userId: string;
  since?: Date;
  until?: Date;
  include?: UserActivityLedgerInclude[];
  agentId?: string;
  projectId?: string;
  issueId?: string;
  limit?: number;
  cursor?: string | null;
}

type ActivityCursor = {
  createdAt: string;
  id: string;
};

type UserActivityLedgerCursor = {
  occurredAt: string;
  kind: UserActivityLedgerKind;
  id: string;
};

type OrganizationActivityRow = {
  activityLog: typeof activityLog.$inferSelect;
  issueIdentifier?: string | null;
  issueTitle?: string | null;
};

type PaginatedOrganizationActivityRow = OrganizationActivityRow & {
  cursorCreatedAt: string;
};

const DEFAULT_ACTIVITY_PAGE_LIMIT = 30;
const MAX_ACTIVITY_PAGE_LIMIT = 100;
const ACTIVITY_CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const USER_ACTIVITY_CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_USER_ACTIVITY_PAGE_LIMIT = 30;
const MAX_USER_ACTIVITY_PAGE_LIMIT = 100;
const DEFAULT_USER_ACTIVITY_INCLUDES: UserActivityLedgerInclude[] = [
  "chat",
  "comments",
  "approvals",
  "activity",
];

function normalizeActivityPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ACTIVITY_PAGE_LIMIT;
  if (!Number.isFinite(limit)) throw badRequest("invalid 'limit' value");
  const normalized = Math.floor(limit);
  if (normalized < 1 || normalized > MAX_ACTIVITY_PAGE_LIMIT) {
    throw badRequest(`'limit' must be between 1 and ${MAX_ACTIVITY_PAGE_LIMIT}`);
  }
  return normalized;
}

function encodeActivityCursor(row: PaginatedOrganizationActivityRow): string {
  return Buffer.from(JSON.stringify({
    createdAt: row.cursorCreatedAt,
    id: row.activityLog.id,
  } satisfies ActivityCursor)).toString("base64url");
}

function decodeActivityCursor(cursor: string | null | undefined): ActivityCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ActivityCursor>;
    if (
      typeof decoded.id !== "string"
      || typeof decoded.createdAt !== "string"
      || !UUID_RE.test(decoded.id)
      || !ACTIVITY_CURSOR_TIMESTAMP_RE.test(decoded.createdAt)
      || Number.isNaN(new Date(decoded.createdAt).getTime())
    ) {
      throw new Error("invalid cursor");
    }
    return { id: decoded.id, createdAt: decoded.createdAt };
  } catch {
    throw badRequest("Activity cursor is invalid or expired");
  }
}

function normalizeUserActivityPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_USER_ACTIVITY_PAGE_LIMIT;
  if (!Number.isFinite(limit)) throw badRequest("invalid 'limit' value");
  const normalized = Math.floor(limit);
  if (normalized < 1 || normalized > MAX_USER_ACTIVITY_PAGE_LIMIT) {
    throw badRequest(`'limit' must be between 1 and ${MAX_USER_ACTIVITY_PAGE_LIMIT}`);
  }
  return normalized;
}

function normalizeUserActivityIncludes(include: UserActivityLedgerInclude[] | undefined): Set<UserActivityLedgerInclude> {
  const values = include && include.length > 0 ? include : DEFAULT_USER_ACTIVITY_INCLUDES;
  return new Set(values);
}

function encodeUserActivityCursor(item: UserActivityLedgerItem): string {
  return Buffer.from(JSON.stringify({
    occurredAt: item.occurredAt,
    kind: item.kind,
    id: item.id,
  } satisfies UserActivityLedgerCursor)).toString("base64url");
}

function decodeUserActivityCursor(cursor: string | null | undefined): UserActivityLedgerCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<UserActivityLedgerCursor>;
    if (
      typeof decoded.id !== "string"
      || typeof decoded.kind !== "string"
      || typeof decoded.occurredAt !== "string"
      || !UUID_RE.test(decoded.id)
      || !USER_ACTIVITY_CURSOR_TIMESTAMP_RE.test(decoded.occurredAt)
      || Number.isNaN(new Date(decoded.occurredAt).getTime())
    ) {
      throw new Error("invalid cursor");
    }
    return {
      id: decoded.id,
      kind: decoded.kind as UserActivityLedgerKind,
      occurredAt: decoded.occurredAt,
    };
  } catch {
    throw badRequest("User activity cursor is invalid or expired");
  }
}

function compareUserActivityItems(a: UserActivityLedgerItem, b: UserActivityLedgerItem): number {
  const timeDiff = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  if (timeDiff !== 0) return timeDiff;
  const kindDiff = a.kind.localeCompare(b.kind);
  if (kindDiff !== 0) return kindDiff;
  return a.id.localeCompare(b.id);
}

function itemIsAfterCursor(item: UserActivityLedgerItem, cursor: UserActivityLedgerCursor | null): boolean {
  if (!cursor) return true;
  return compareUserActivityItems(item, {
    id: cursor.id,
    kind: cursor.kind,
    occurredAt: cursor.occurredAt,
    userId: item.userId,
    actor: item.actor,
    summary: "",
    excerpt: null,
    source: item.source,
    related: [],
  }) > 0;
}

function safeExcerpt(value: string | null | undefined, maxLength = 240): string | null {
  const collapsed = value?.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 3).trimEnd()}...`;
}

function titleFromDetails(details: Record<string, unknown> | null | undefined): string | null {
  if (!details) return null;
  for (const key of ["title", "issueTitle", "name", "summary"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function isLowSignalContentOnlyIssueUpdate(event: typeof activityLog.$inferSelect): boolean {
  return isLowSignalIssueContentOnlyUpdate(event.action, event.details);
}

function shouldShowIssueActivity(event: typeof activityLog.$inferSelect): boolean {
  if (event.action === "issue.document_updated") return false;
  if (isLowSignalContentOnlyIssueUpdate(event)) return false;
  return true;
}

function shouldShowOrganizationActivity(event: typeof activityLog.$inferSelect): boolean {
  if (isLowSignalContentOnlyIssueUpdate(event)) return false;
  return true;
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  const approvalIdAsText = sql<string>`${approvals.id}::text`;
  const conversationIdAsText = sql<string>`${chatConversations.id}::text`;
  const organizationActivityVisibleCondition = and(
    ne(activityLog.action, "issue.read_marked"),
    sql`not (${issueLowSignalContentOnlyActivitySql("activity_log")})`,
  );
  const activityCursorCreatedAt = sql<string>`to_char(${activityLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  function userActivityCursorCondition(
    createdAtColumn: any,
    idColumn: any,
    kind: UserActivityLedgerKind,
    cursor: UserActivityLedgerCursor | null,
  ) {
    if (!cursor) return undefined;
    const cursorDate = new Date(cursor.occurredAt);
    const cursorTimestamp = cursor.occurredAt;
    const kindOrder = kind.localeCompare(cursor.kind);
    const sameTimestampCondition = kindOrder > 0
      ? sql`${createdAtColumn} = ${cursorTimestamp}::timestamptz`
      : kindOrder === 0
        ? and(
            sql`${createdAtColumn} = ${cursorTimestamp}::timestamptz`,
            sql`${idColumn}::text > ${cursor.id}`,
          )
        : undefined;
    return sameTimestampCondition
      ? or(lt(createdAtColumn, cursorDate), sameTimestampCondition)
      : lt(createdAtColumn, cursorDate);
  }

  function timeConditions(createdAtColumn: any, filters: UserActivityLedgerFilters) {
    const conditions = [];
    if (filters.since) conditions.push(gte(createdAtColumn, filters.since));
    if (filters.until) conditions.push(lte(createdAtColumn, filters.until));
    return conditions;
  }

  function approvalLinkedIssueCondition(issueId: string) {
    return or(
      sql`${approvals.payload}->>'issueId' = ${issueId}`,
      sql`${approvals.payload}->>'primaryIssueId' = ${issueId}`,
      sql`${approvals.payload}->'issueIds' ? ${issueId}`,
    );
  }

  function approvalProjectCondition(projectId: string) {
    return or(
      sql`${approvals.payload}->>'projectId' = ${projectId}`,
      sql`exists (
        select 1
        from ${issues}
        where ${issues.orgId} = ${approvals.orgId}
          and ${issues.projectId} = ${projectId}
          and ${issues.hiddenAt} is null
          and (
            ${issues.id}::text = ${approvals.payload}->>'issueId'
            or ${issues.id}::text = ${approvals.payload}->>'primaryIssueId'
            or ${approvals.payload}->'issueIds' ? ${issues.id}::text
          )
      )`,
    );
  }

  function withUserActor(userId: string, displayName: string | null | undefined) {
    return {
      type: "user" as const,
      id: userId,
      displayName: displayName ?? null,
    };
  }

  function activityRowWithIssueDetails(row: OrganizationActivityRow) {
    if (row.activityLog.entityType !== "issue") return row.activityLog;
    if (!row.issueIdentifier && !row.issueTitle) return row.activityLog;
    const details = row.activityLog.details ?? {};
    return {
      ...row.activityLog,
      details: {
        ...details,
        ...(row.issueIdentifier ? { issueIdentifier: row.issueIdentifier } : {}),
        ...(row.issueTitle ? { issueTitle: row.issueTitle } : {}),
        ...(row.issueIdentifier && typeof details.identifier !== "string" ? { identifier: row.issueIdentifier } : {}),
        ...(row.issueTitle && typeof details.title !== "string" ? { title: row.issueTitle } : {}),
      },
    };
  }

  function organizationActivityConditions(filters: ActivityFilters) {
    const conditions = [eq(activityLog.orgId, filters.orgId)];
    if (organizationActivityVisibleCondition) conditions.push(organizationActivityVisibleCondition);

    if (filters.agentId) {
      const agentCondition = or(
        eq(activityLog.agentId, filters.agentId),
        and(
          eq(activityLog.actorType, "agent"),
          eq(activityLog.actorId, filters.agentId),
        ),
      );
      if (agentCondition) conditions.push(agentCondition);
    }
    if (filters.userId) {
      conditions.push(eq(activityLog.actorType, "user"));
      conditions.push(eq(activityLog.actorId, filters.userId));
    }
    if (filters.actorType) {
      conditions.push(eq(activityLog.actorType, filters.actorType));
    }
    if (filters.actorId) {
      conditions.push(eq(activityLog.actorId, filters.actorId));
    }
    if (filters.entityType) {
      conditions.push(eq(activityLog.entityType, filters.entityType));
    }
    if (filters.entityId) {
      conditions.push(eq(activityLog.entityId, filters.entityId));
    }

    return conditions;
  }

  return {
    listUserActivityLedger: async (filters: UserActivityLedgerFilters) => {
      const limit = normalizeUserActivityPageLimit(filters.limit);
      const cursor = decodeUserActivityCursor(filters.cursor);
      const includes = normalizeUserActivityIncludes(filters.include);
      const perSourceLimit = limit + 1;
      const [profile] = await db
        .select({ nickname: operatorProfiles.nickname })
        .from(operatorProfiles)
        .where(eq(operatorProfiles.userId, filters.userId))
        .limit(1);
      const actor = withUserActor(filters.userId, profile?.nickname);
      const items: UserActivityLedgerItem[] = [];

      if (includes.has("chat")) {
        const conditions = [
          eq(chatMessages.orgId, filters.orgId),
          eq(chatMessages.role, "user"),
          eq(chatConversations.orgId, filters.orgId),
          eq(chatConversations.createdByUserId, filters.userId),
          isNull(chatMessages.supersededAt),
          ...timeConditions(chatMessages.createdAt, filters),
        ];
        const cursorSql = userActivityCursorCondition(chatMessages.createdAt, chatMessages.id, "chat_message", cursor);
        if (cursorSql) conditions.push(cursorSql);
        if (filters.agentId) {
          conditions.push(or(
            eq(chatMessages.replyingAgentId, filters.agentId),
            eq(chatConversations.preferredAgentId, filters.agentId),
            eq(chatConversations.routedAgentId, filters.agentId),
          )!);
        }
        if (filters.projectId) {
          conditions.push(eq(issues.projectId, filters.projectId));
        }
        if (filters.issueId) {
          conditions.push(eq(chatConversations.primaryIssueId, filters.issueId));
        }

        const rows = await db
          .select({
            message: chatMessages,
            conversationTitle: chatConversations.title,
            preferredAgentId: chatConversations.preferredAgentId,
            routedAgentId: chatConversations.routedAgentId,
            primaryIssueId: chatConversations.primaryIssueId,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueProjectId: issues.projectId,
            issueGoalId: issues.goalId,
          })
          .from(chatMessages)
          .innerJoin(
            chatConversations,
            and(
              eq(chatMessages.conversationId, chatConversations.id),
              eq(chatMessages.orgId, chatConversations.orgId),
            ),
          )
          .leftJoin(
            issues,
            and(
              eq(chatConversations.primaryIssueId, issues.id),
              eq(chatConversations.orgId, issues.orgId),
              isNull(issues.hiddenAt),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(chatMessages.createdAt), asc(chatMessages.id))
          .limit(perSourceLimit);

        for (const row of rows) {
          const related: UserActivityLedgerItem["related"] = [
            { type: "chat", id: row.message.conversationId, label: row.conversationTitle },
          ];
          if (row.message.replyingAgentId) related.push({ type: "agent", id: row.message.replyingAgentId });
          if (row.preferredAgentId && row.preferredAgentId !== row.message.replyingAgentId) {
            related.push({ type: "agent", id: row.preferredAgentId });
          }
          if (row.routedAgentId && row.routedAgentId !== row.message.replyingAgentId && row.routedAgentId !== row.preferredAgentId) {
            related.push({ type: "agent", id: row.routedAgentId });
          }
          if (row.primaryIssueId) {
            related.push({
              type: "issue",
              id: row.primaryIssueId,
              label: row.issueIdentifier ?? row.issueTitle,
            });
          }
          if (row.issueProjectId) related.push({ type: "project", id: row.issueProjectId });
          if (row.issueGoalId) related.push({ type: "goal", id: row.issueGoalId });
          items.push({
            id: row.message.id,
            kind: "chat_message",
            occurredAt: row.message.createdAt.toISOString(),
            userId: filters.userId,
            actor,
            summary: `User message in chat: ${row.conversationTitle || "Untitled chat"}`,
            excerpt: safeExcerpt(row.message.body),
            source: {
              type: "chat",
              id: row.message.conversationId,
              link: `chat://${row.message.conversationId}`,
              provenance: {
                table: "chat_messages",
                id: row.message.id,
                orgId: row.message.orgId,
              },
            },
            related,
            metadata: {
              messageId: row.message.id,
              messageKind: row.message.kind,
              messageStatus: row.message.status,
              runId: row.message.runId,
            },
          });
        }
      }

      if (includes.has("comments") || includes.has("issues")) {
        const conditions = [
          eq(issueComments.orgId, filters.orgId),
          eq(issueComments.authorUserId, filters.userId),
          eq(issues.orgId, filters.orgId),
          isNull(issueComments.deletedAt),
          isNull(issues.hiddenAt),
          ...timeConditions(issueComments.createdAt, filters),
        ];
        const cursorSql = userActivityCursorCondition(issueComments.createdAt, issueComments.id, "issue_comment", cursor);
        if (cursorSql) conditions.push(cursorSql);
        if (filters.projectId) conditions.push(eq(issues.projectId, filters.projectId));
        if (filters.issueId) conditions.push(eq(issueComments.issueId, filters.issueId));
        if (filters.agentId) {
          conditions.push(or(
            eq(issues.assigneeAgentId, filters.agentId),
            eq(issues.reviewerAgentId, filters.agentId),
          )!);
        }

        const rows = await db
          .select({
            comment: issueComments,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            projectId: issues.projectId,
            goalId: issues.goalId,
            assigneeAgentId: issues.assigneeAgentId,
            reviewerAgentId: issues.reviewerAgentId,
          })
          .from(issueComments)
          .innerJoin(
            issues,
            and(
              eq(issueComments.issueId, issues.id),
              eq(issueComments.orgId, issues.orgId),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(issueComments.createdAt), asc(issueComments.id))
          .limit(perSourceLimit);

        for (const row of rows) {
          const related: UserActivityLedgerItem["related"] = [
            {
              type: "issue",
              id: row.comment.issueId,
              label: row.issueIdentifier ?? row.issueTitle,
            },
          ];
          if (row.projectId) related.push({ type: "project", id: row.projectId });
          if (row.goalId) related.push({ type: "goal", id: row.goalId });
          if (row.assigneeAgentId) related.push({ type: "agent", id: row.assigneeAgentId });
          if (row.reviewerAgentId && row.reviewerAgentId !== row.assigneeAgentId) {
            related.push({ type: "agent", id: row.reviewerAgentId });
          }
          items.push({
            id: row.comment.id,
            kind: "issue_comment",
            occurredAt: row.comment.createdAt.toISOString(),
            userId: filters.userId,
            actor,
            summary: `User commented on ${row.issueIdentifier ?? "issue"}: ${row.issueTitle}`,
            excerpt: safeExcerpt(row.comment.body),
            source: {
              type: "comment",
              id: row.comment.id,
              link: `issue://${row.comment.issueId}?c=${row.comment.id}`,
              provenance: {
                table: "issue_comments",
                id: row.comment.id,
                orgId: row.comment.orgId,
              },
            },
            related,
            metadata: {
              issueId: row.comment.issueId,
              issueIdentifier: row.issueIdentifier,
              issueStatus: row.issueStatus,
            },
          });
        }
      }

      if (includes.has("approvals")) {
        const conditions = [
          eq(approvalComments.orgId, filters.orgId),
          eq(approvalComments.authorUserId, filters.userId),
          eq(approvals.orgId, filters.orgId),
          ...timeConditions(approvalComments.createdAt, filters),
        ];
        const cursorSql = userActivityCursorCondition(
          approvalComments.createdAt,
          approvalComments.id,
          "approval_comment",
          cursor,
        );
        if (cursorSql) conditions.push(cursorSql);
        if (filters.agentId) conditions.push(eq(approvals.requestedByAgentId, filters.agentId));
        if (filters.issueId) {
          conditions.push(approvalLinkedIssueCondition(filters.issueId)!);
        }
        if (filters.projectId) {
          conditions.push(approvalProjectCondition(filters.projectId)!);
        }

        const rows = await db
          .select({
            comment: approvalComments,
            approvalType: approvals.type,
            approvalStatus: approvals.status,
            requestedByAgentId: approvals.requestedByAgentId,
          })
          .from(approvalComments)
          .innerJoin(
            approvals,
            and(
              eq(approvalComments.approvalId, approvals.id),
              eq(approvalComments.orgId, approvals.orgId),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(approvalComments.createdAt), asc(approvalComments.id))
          .limit(perSourceLimit);

        for (const row of rows) {
          const related: UserActivityLedgerItem["related"] = [
            { type: "approval", id: row.comment.approvalId, label: row.approvalType },
          ];
          if (row.requestedByAgentId) related.push({ type: "agent", id: row.requestedByAgentId });
          items.push({
            id: row.comment.id,
            kind: "approval_comment",
            occurredAt: row.comment.createdAt.toISOString(),
            userId: filters.userId,
            actor,
            summary: `User commented on ${row.approvalType} approval`,
            excerpt: safeExcerpt(row.comment.body),
            source: {
              type: "approval",
              id: row.comment.approvalId,
              link: `approval://${row.comment.approvalId}?c=${row.comment.id}`,
              provenance: {
                table: "approval_comments",
                id: row.comment.id,
                orgId: row.comment.orgId,
              },
            },
            related,
            metadata: {
              approvalId: row.comment.approvalId,
              approvalType: row.approvalType,
              approvalStatus: row.approvalStatus,
            },
          });
        }
      }

      if (includes.has("activity") || includes.has("issues") || includes.has("approvals")) {
        const activityIncludeCondition = includes.has("activity")
          ? undefined
          : or(
              includes.has("issues") ? eq(activityLog.entityType, "issue") : undefined,
              includes.has("approvals") ? eq(activityLog.entityType, "approval") : undefined,
            );
        const conditions = [
          eq(activityLog.orgId, filters.orgId),
          eq(activityLog.actorType, "user"),
          eq(activityLog.actorId, filters.userId),
          ne(activityLog.action, "issue.comment_added"),
          ne(activityLog.action, "approval.comment_added"),
          ne(activityLog.action, "issue.read_marked"),
          sql`not (${issueLowSignalContentOnlyActivitySql("activity_log")})`,
          ...timeConditions(activityLog.createdAt, filters),
        ];
        if (activityIncludeCondition) conditions.push(activityIncludeCondition);
        const cursorSql = userActivityCursorCondition(activityLog.createdAt, activityLog.id, "activity_event", cursor);
        if (cursorSql) conditions.push(cursorSql);
        if (filters.agentId) {
          conditions.push(or(
            eq(activityLog.agentId, filters.agentId),
            and(eq(activityLog.actorType, "agent"), eq(activityLog.actorId, filters.agentId)),
            eq(approvals.requestedByAgentId, filters.agentId),
          )!);
        }
        if (filters.issueId) {
          conditions.push(or(
            and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, filters.issueId)),
            and(eq(activityLog.entityType, "approval"), approvalLinkedIssueCondition(filters.issueId)!),
          )!);
        }
        if (filters.projectId) {
          conditions.push(or(
            and(eq(activityLog.entityType, "project"), eq(activityLog.entityId, filters.projectId)),
            eq(issues.projectId, filters.projectId),
            and(eq(activityLog.entityType, "approval"), approvalProjectCondition(filters.projectId)!),
          )!);
        }

        const rows = await db
          .select({
            event: activityLog,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueProjectId: issues.projectId,
            issueGoalId: issues.goalId,
            agentName: agents.name,
            approvalType: approvals.type,
            approvalRequestedByAgentId: approvals.requestedByAgentId,
          })
          .from(activityLog)
          .leftJoin(
            issues,
            and(
              eq(activityLog.entityType, sql`'issue'`),
              eq(issues.orgId, activityLog.orgId),
              eq(activityLog.entityId, issueIdAsText),
              isNull(issues.hiddenAt),
            ),
          )
          .leftJoin(
            approvals,
            and(
              eq(activityLog.entityType, sql`'approval'`),
              eq(approvals.orgId, activityLog.orgId),
              eq(activityLog.entityId, approvalIdAsText),
            ),
          )
          .leftJoin(
            agents,
            and(
              eq(activityLog.agentId, agents.id),
              eq(activityLog.orgId, agents.orgId),
            ),
          )
          .where(and(...conditions))
          .orderBy(desc(activityLog.createdAt), asc(activityLog.id))
          .limit(perSourceLimit);

        for (const row of rows) {
          if (row.event.entityType === "issue" && !row.issueIdentifier && !row.issueTitle) continue;
          if (row.event.entityType === "approval" && !row.approvalType) continue;
          const details = row.event.details ?? null;
          const related: UserActivityLedgerItem["related"] = [];
          if (row.event.agentId) related.push({ type: "agent", id: row.event.agentId, label: row.agentName });
          if (row.approvalRequestedByAgentId && row.approvalRequestedByAgentId !== row.event.agentId) {
            related.push({ type: "agent", id: row.approvalRequestedByAgentId });
          }
          if (row.event.runId) related.push({ type: "run", id: row.event.runId });
          if (row.event.entityType === "issue") {
            related.push({
              type: "issue",
              id: row.event.entityId,
              label: row.issueIdentifier ?? row.issueTitle,
            });
          }
          if (row.event.entityType === "chat") related.push({ type: "chat", id: row.event.entityId });
          if (row.event.entityType === "approval") {
            related.push({ type: "approval", id: row.event.entityId, label: row.approvalType });
          }
          if (row.event.entityType === "project") related.push({ type: "project", id: row.event.entityId });
          if (row.issueProjectId) related.push({ type: "project", id: row.issueProjectId });
          if (row.issueGoalId) related.push({ type: "goal", id: row.issueGoalId });
          const detailTitle = titleFromDetails(details);
          items.push({
            id: row.event.id,
            kind: "activity_event",
            occurredAt: row.event.createdAt.toISOString(),
            userId: filters.userId,
            actor,
            summary: detailTitle
              ? `User ${row.event.action} on ${row.event.entityType}: ${detailTitle}`
              : `User ${row.event.action} on ${row.event.entityType}`,
            excerpt: safeExcerpt(
              typeof details?.note === "string"
                ? details.note
                : typeof details?.comment === "string"
                  ? details.comment
                  : null,
            ),
            source: {
              type: "activity",
              id: row.event.id,
              link: row.event.entityType === "issue" ? `issue://${row.event.entityId}` : null,
              provenance: {
                table: "activity_log",
                id: row.event.id,
                orgId: row.event.orgId,
              },
            },
            related,
            metadata: {
              action: row.event.action,
              entityType: row.event.entityType,
              entityId: row.event.entityId,
              details,
            },
          });
        }
      }

      const sortedItems = items
        .filter((item) => itemIsAfterCursor(item, cursor))
        .sort(compareUserActivityItems);
      const pageItems = sortedItems.slice(0, limit);
      return {
        items: pageItems,
        nextCursor: sortedItems.length > limit && pageItems.length > 0
          ? encodeUserActivityCursor(pageItems[pageItems.length - 1]!)
          : null,
      };
    },

    list: (filters: ActivityFilters) => {
      const conditions = organizationActivityConditions(filters);

      return db
        .select({
          activityLog,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(issues.orgId, activityLog.orgId),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              isNull(issues.hiddenAt),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .then((rows) => rows.map(activityRowWithIssueDetails).filter(shouldShowOrganizationActivity));
    },

    listPage: async (filters: ActivityPageFilters) => {
      const limit = normalizeActivityPageLimit(filters.limit);
      const decodedCursor = decodeActivityCursor(filters.cursor);
      const conditions = organizationActivityConditions(filters);
      if (decodedCursor) {
        conditions.push(
          or(
            sql`${activityLog.createdAt} < ${decodedCursor.createdAt}::timestamptz`,
            and(
              sql`${activityLog.createdAt} = ${decodedCursor.createdAt}::timestamptz`,
              sql`${activityLog.id} < ${decodedCursor.id}::uuid`,
            ),
          )!,
        );
      }

      const rows = await db
        .select({
          activityLog,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          cursorCreatedAt: activityCursorCreatedAt,
        })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(issues.orgId, activityLog.orgId),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              isNull(issues.hiddenAt),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(limit + 1);

      const pageRows = rows.slice(0, limit);
      return {
        items: pageRows.map(activityRowWithIssueDetails).filter(shouldShowOrganizationActivity),
        nextCursor: rows.length > limit && pageRows.length > 0
          ? encodeActivityCursor(pageRows[pageRows.length - 1]!)
          : null,
      };
    },

    forIssue: async (issueId: string) => {
      const [issueEvents, relatedChatEvents] = await Promise.all([
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issueId),
              ne(activityLog.action, "issue.read_marked"),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
        db
          .select({
            activityLog,
            conversationTitle: chatConversations.title,
          })
          .from(activityLog)
          .innerJoin(
            chatConversations,
            and(
              eq(activityLog.entityType, "chat"),
              eq(activityLog.entityId, conversationIdAsText),
            ),
          )
          .leftJoin(
            chatContextLinks,
            and(
              eq(chatContextLinks.conversationId, chatConversations.id),
              eq(chatContextLinks.entityType, "issue"),
              eq(chatContextLinks.entityId, issueId),
            ),
          )
          .where(
            or(
              and(
                eq(activityLog.action, "chat.issue_converted"),
                sql`${activityLog.details} ->> 'issueId' = ${issueId}`,
              ),
              and(
                eq(activityLog.action, "chat.context_linked"),
                sql`${activityLog.details} ->> 'entityType' = 'issue'`,
                sql`${activityLog.details} ->> 'entityId' = ${issueId}`,
              ),
              and(
                eq(activityLog.action, "chat.created"),
                isNotNull(chatContextLinks.id),
                sql`coalesce((${activityLog.details} ->> 'contextLinkCount')::int, 0) > 0`,
              ),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
      ]);

      const merged = [
        ...issueEvents.filter(shouldShowIssueActivity),
        ...relatedChatEvents.map(({ activityLog: event, conversationTitle }) => ({
          ...event,
          details: {
            ...(event.details ?? {}),
            conversationTitle,
          },
        })),
      ];

      return merged.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },

    runsForIssue: (orgId: string, issueId: string) =>
      db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          triggerDetail: heartbeatRuns.triggerDetail,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.orgId, orgId),
            or(
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
              sql`exists (
                select 1
                from ${activityLog}
                where ${activityLog.orgId} = ${orgId}
                  and ${activityLog.entityType} = 'issue'
                  and ${activityLog.entityId} = ${issueId}
                  and ${activityLog.runId} = ${heartbeatRuns.id}
              )`,
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt)),

    issuesForRun: async (runId: string) => {
      const run = await db
        .select({
          orgId: heartbeatRuns.orgId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([issueIdAsText], {
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .where(
          and(
            eq(activityLog.orgId, run.orgId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "issue"),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issueIdAsText);

      const context = run.contextSnapshot;
      const contextIssueId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).issueId === "string"
          ? ((context as Record<string, unknown>).issueId as string)
          : null;
      if (!contextIssueId) return fromActivity;
      if (fromActivity.some((issue) => issue.issueId === contextIssueId)) return fromActivity;

      const fromContext = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          and(
            eq(issues.orgId, run.orgId),
            eq(issues.id, contextIssueId),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    create: (data: typeof activityLog.$inferInsert) =>
      db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]),
  };
}
