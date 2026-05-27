import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agents,
  approvals,
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  heartbeatRuns,
  issueComments,
  issueReadStates,
  issues,
} from "@rudderhq/db";
import type { SidebarBadges } from "@rudderhq/shared";
import { visibleIncomingMessageSql } from "./chats.helpers.js";

const ACTIONABLE_APPROVAL_STATUSES = ["pending"];
const INBOX_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done"];
const INBOX_ISSUE_STATUS_SQL = sql.join(INBOX_ISSUE_STATUSES.map((status) => sql`${status}`), sql`, `);

type SidebarBadgeBaseCounts = {
  approvals: number;
  failedRuns: number;
};

type SidebarBadgeExtraCounts = {
  joinRequests?: number;
  unreadTouchedIssues?: number;
  chatAttention?: number;
  alerts?: number;
};

function buildBadges(
  base: SidebarBadgeBaseCounts,
  extra?: SidebarBadgeExtraCounts,
): SidebarBadges {
  const joinRequests = extra?.joinRequests ?? 0;
  const unreadTouchedIssues = extra?.unreadTouchedIssues ?? 0;
  const chatAttention = extra?.chatAttention ?? 0;
  const alerts = extra?.alerts ?? 0;
  return {
    inbox:
      base.approvals +
      base.failedRuns +
      joinRequests +
      unreadTouchedIssues +
      chatAttention +
      alerts,
    approvals: base.approvals,
    failedRuns: base.failedRuns,
    joinRequests,
    unreadTouchedIssues,
    chatAttention,
    alerts,
  };
}

export function sidebarBadgeService(db: Db) {
  async function countActionableApprovals(orgId: string) {
    return db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, orgId),
          inArray(approvals.status, ACTIONABLE_APPROVAL_STATUSES),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countFailedLatestRuns(orgId: string) {
    const rows = await db.execute(sql<{ count: number }>`
      select count(*)::int as count
      from (
        select
          ${heartbeatRuns.status} as run_status,
          row_number() over (
            partition by ${heartbeatRuns.agentId}
            order by ${heartbeatRuns.createdAt} desc
          ) as run_rank
        from ${heartbeatRuns}
        inner join ${agents}
          on ${heartbeatRuns.agentId} = ${agents.id}
          and ${agents.orgId} = ${orgId}
        where ${heartbeatRuns.orgId} = ${orgId}
          and ${agents.status} <> 'terminated'
      ) latest_agent_runs
      where latest_agent_runs.run_rank = 1
        and latest_agent_runs.run_status in ('failed', 'timed_out')
    `);

    return Number(rows[0]?.count ?? 0);
  }

  async function ensureActiveChatUserStates(orgId: string, userId: string) {
    await db.execute(sql`
      insert into chat_conversation_user_states (
        org_id,
        conversation_id,
        user_id,
        last_read_at,
        updated_at
      )
      select
        ${chatConversations.orgId},
        ${chatConversations.id},
        ${userId},
        coalesce(${chatConversations.lastMessageAt}, ${chatConversations.updatedAt}, ${chatConversations.createdAt}),
        now()
      from ${chatConversations}
      where ${chatConversations.orgId} = ${orgId}
        and ${chatConversations.status} = 'active'
      on conflict (org_id, conversation_id, user_id) do nothing
    `);
  }

  return {
    countUnreadTouchedIssues: async (orgId: string, userId: string) => {
      const rows = await db.execute(sql<{ count: number }>`
        with comment_stats as (
          select
            ${issueComments.issueId} as issue_id,
            max(${issueComments.createdAt}) filter (
              where ${issueComments.authorUserId} = ${userId}
            ) as my_last_comment_at,
            max(${issueComments.createdAt}) filter (
              where ${issueComments.authorUserId} is null
                or ${issueComments.authorUserId} <> ${userId}
            ) as last_external_comment_at
          from ${issueComments}
          where ${issueComments.orgId} = ${orgId}
          group by ${issueComments.issueId}
        ),
        read_stats as (
          select
            ${issueReadStates.issueId} as issue_id,
            max(${issueReadStates.lastReadAt}) as my_last_read_at
          from ${issueReadStates}
          where ${issueReadStates.orgId} = ${orgId}
            and ${issueReadStates.userId} = ${userId}
          group by ${issueReadStates.issueId}
        )
        select count(*)::int as count
        from ${issues}
        left join comment_stats on comment_stats.issue_id = ${issues.id}
        left join read_stats on read_stats.issue_id = ${issues.id}
        where ${issues.orgId} = ${orgId}
          and ${issues.status} in (${INBOX_ISSUE_STATUS_SQL})
          and ${issues.originKind} <> 'automation_execution'
          and ${issues.hiddenAt} is null
          and (
            ${issues.createdByUserId} = ${userId}
            or ${issues.assigneeUserId} = ${userId}
            or ${issues.reviewerUserId} = ${userId}
            or read_stats.my_last_read_at is not null
            or comment_stats.my_last_comment_at is not null
          )
          and comment_stats.last_external_comment_at > greatest(
            coalesce(comment_stats.my_last_comment_at, to_timestamp(0)),
            coalesce(read_stats.my_last_read_at, to_timestamp(0)),
            coalesce(case when ${issues.createdByUserId} = ${userId} then ${issues.createdAt} else null end, to_timestamp(0)),
            coalesce(case when ${issues.assigneeUserId} = ${userId} then ${issues.updatedAt} else null end, to_timestamp(0)),
            coalesce(case when ${issues.reviewerUserId} = ${userId} then ${issues.updatedAt} else null end, to_timestamp(0))
          )
      `);
      return Number(rows[0]?.count ?? 0);
    },

    countActiveChatAttention: async (orgId: string, userId: string) => {
      await ensureActiveChatUserStates(orgId, userId);

      return db
        .select({ count: sql<number>`count(*)` })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.orgId, orgId),
            eq(chatConversations.status, "active"),
            sql<boolean>`(
              exists (
                select 1
                from ${chatMessages}
                inner join ${chatConversationUserStates}
                  on ${chatConversationUserStates.orgId} = ${orgId}
                  and ${chatConversationUserStates.userId} = ${userId}
                  and ${chatConversationUserStates.conversationId} = ${chatMessages.conversationId}
                where ${chatMessages.orgId} = ${orgId}
                  and ${chatMessages.conversationId} = ${chatConversations.id}
                  and ${chatMessages.supersededAt} is null
                  and ${visibleIncomingMessageSql()}
                  and ${chatMessages.createdAt} > ${chatConversationUserStates.lastReadAt}
              )
              or exists (
                select 1
                from ${chatMessages}
                inner join ${approvals} on ${chatMessages.approvalId} = ${approvals.id}
                where ${chatMessages.orgId} = ${orgId}
                  and ${chatMessages.conversationId} = ${chatConversations.id}
                  and ${chatMessages.supersededAt} is null
                  and ${approvals.orgId} = ${orgId}
                  and ${approvals.status} = 'pending'
              )
            )`,
          ),
        )
        .then((rows) => Number(rows[0]?.count ?? 0));
    },

    getBaseCounts: async (orgId: string): Promise<SidebarBadgeBaseCounts> => {
      const [approvals, failedRuns] = await Promise.all([
        countActionableApprovals(orgId),
        countFailedLatestRuns(orgId),
      ]);
      return { approvals, failedRuns };
    },

    get: async (
      orgId: string,
      extra?: SidebarBadgeExtraCounts,
    ): Promise<SidebarBadges> => {
      const [approvals, failedRuns] = await Promise.all([
        countActionableApprovals(orgId),
        countFailedLatestRuns(orgId),
      ]);
      return buildBadges({ approvals, failedRuns }, extra);
    },

    fromCounts: buildBadges,
    constants: {
      inboxIssueStatuses: INBOX_ISSUE_STATUSES,
    },
  };
}
