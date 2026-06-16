import type { Db } from "@rudderhq/db";
import { activityLog, chatContextLinks, chatConversations, heartbeatRuns, issues } from "@rudderhq/db";
import { isLowSignalIssueContentOnlyUpdate } from "@rudderhq/shared";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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

type ActivityCursor = {
  createdAt: string;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const conversationIdAsText = sql<string>`${chatConversations.id}::text`;
  const organizationActivityVisibleCondition = and(
    ne(activityLog.action, "issue.read_marked"),
    sql`not (${issueLowSignalContentOnlyActivitySql("activity_log")})`,
  );
  const activityCursorCreatedAt = sql<string>`to_char(${activityLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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
