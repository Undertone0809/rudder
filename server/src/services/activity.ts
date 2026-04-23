import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@rudder/db";
import { activityLog, chatContextLinks, chatConversations, heartbeatRuns, issues } from "@rudder/db";

export interface ActivityFilters {
  orgId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  const conversationIdAsText = sql<string>`${chatConversations.id}::text`;
  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.orgId, filters.orgId)];
      conditions.push(ne(activityLog.action, "issue.read_marked"));

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
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
        .orderBy(desc(activityLog.createdAt))
        .then((rows) => rows.map((r) => r.activityLog));
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
        ...issueEvents,
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
